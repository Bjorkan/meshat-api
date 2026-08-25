import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { ApiError, notFound } from "./errors.js";

const runFile = promisify(execFile);
export const DOCS_SEARCH_MAX_FILES = 100;
export const DOCS_SEARCH_MAX_TOTAL_BYTES = 4 * 1024 * 1024;

export type DocsStatus = "fresh" | "stale" | "unavailable";
export type DocsMetadata = {
  repository: string;
  ref: string | null;
  commit: string | null;
  status: DocsStatus;
};
export type DocFile = {
  path: string;
  title: string | null;
  media_type: "text/markdown" | "application/yaml";
  size: number;
};
export type DocsSearchResult = {
  query: string;
  limit: number;
  returned: number;
  total_matches: number;
  scan_complete: boolean;
  truncated: boolean;
  results: Array<DocFile & { snippet: string }>;
};

export interface DocumentationService {
  refresh(): Promise<void>;
  metadata(): DocsMetadata;
  index(): Promise<DocFile[]>;
  search(query: string, limit: number): Promise<DocsSearchResult>;
  get(path: string): Promise<{
    path: string;
    media_type: string;
    content: string;
    encoding: "utf-8";
    source: Omit<DocsMetadata, "status">;
  }>;
}

type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string }>;

export class GitDocumentationService implements DocumentationService {
  private state: DocsMetadata;
  private readonly repository: string;
  private cacheAllowed = true;

  constructor(
    private readonly options: AppConfig["docs"],
    private readonly run: CommandRunner = async (command, args, commandOptions) => {
      const result = await runFile(command, args, {
        cwd: commandOptions?.cwd,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
      return { stdout: result.stdout };
    },
  ) {
    const repository = new URL(options.repository);
    if (repository.username || repository.password) {
      throw new Error("Documentation repository URL must not contain credentials");
    }
    this.repository = options.repository;
    this.state = {
      repository: this.repository,
      ref: null,
      commit: null,
      status: "unavailable",
    };
  }

  metadata() {
    return { ...this.state };
  }

  async refresh() {
    await this.recoverInterruptedInstall();
    const cached = await this.validCheckout();
    try {
      this.state = cached ? await this.updateCheckout() : await this.cloneCheckout();
      this.cacheAllowed = true;
    } catch (error) {
      if (await this.validCheckout()) {
        try {
          const cachedMetadata = await this.resolveMetadataAt(this.options.cacheDir, "stale");
          if (this.matchesConfiguration(cachedMetadata)) {
            this.state = cachedMetadata;
            this.cacheAllowed = true;
            return;
          }
        } catch {
          // Unverifiable provenance must never be exposed as a stale cache.
        }
      }
      this.cacheAllowed = false;
      this.state = {
        repository: this.repository,
        ref: this.options.ref || null,
        commit: null,
        status: "unavailable",
      };
      throw error;
    }
  }

  async index() {
    const root = await this.docsRoot();
    const files: DocFile[] = [];
    await this.walk(root, root, files, true);
    return files.sort((left, right) => comparePaths(left.path, right.path));
  }

  async search(query: string, limit: number) {
    const normalizedQuery = query.trim();
    const needle = normalizedQuery.toLocaleLowerCase();
    if (!needle) throw new ApiError(422, "INVALID_ARGUMENT", "Search query is required.");
    const results: Array<DocFile & { snippet: string; score: number }> = [];
    const files = await this.index();
    let scannedBytes = 0;
    let scannedFiles = 0;
    let scanFailed = false;
    for (const file of files) {
      if (
        scannedFiles >= DOCS_SEARCH_MAX_FILES ||
        scannedBytes + file.size > DOCS_SEARCH_MAX_TOTAL_BYTES
      )
        break;
      scannedFiles += 1;
      scannedBytes += file.size;
      let content: string;
      try {
        const safe = await this.safeFile(file.path);
        content = await readUtf8(safe, this.options.maxFileBytes);
      } catch {
        scanFailed = true;
        continue;
      }
      const lower = content.toLocaleLowerCase();
      const index = lower.indexOf(needle);
      if (index < 0) continue;
      const start = Math.max(0, index - 90);
      const end = Math.min(content.length, index + needle.length + 150);
      const snippet = content.slice(start, end).replace(/\s+/g, " ").trim();
      results.push({
        ...file,
        title: titleFromContent(content, file.path),
        snippet: `${start ? "..." : ""}${snippet}${end < content.length ? "..." : ""}`,
        score: countOccurrences(lower, needle),
      });
    }
    const ranked = results
      .sort((left, right) => right.score - left.score || comparePaths(left.path, right.path))
      .map(({ score: _score, ...result }) => result);
    const matches = ranked.slice(0, limit);
    const scanComplete = !scanFailed && scannedFiles === files.length;
    return {
      query: normalizedQuery,
      limit,
      returned: matches.length,
      total_matches: ranked.length,
      scan_complete: scanComplete,
      truncated: !scanComplete || ranked.length > matches.length,
      results: matches,
    };
  }

  async get(requestPath: string) {
    const normalizedPath = normalizePath(requestPath);
    if (!isPublicDocument(normalizedPath)) throw notFound("Documentation file");
    const filePath = await this.safeFile(normalizedPath);
    const details = await stat(filePath);
    if (!details.isFile()) throw notFound("Documentation file");
    if (details.size > this.options.maxFileBytes) {
      throw new ApiError(
        413,
        "INVALID_ARGUMENT",
        "Documentation file exceeds the configured size limit.",
      );
    }
    let content: string;
    try {
      content = await readUtf8(filePath, this.options.maxFileBytes);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw notFound("Documentation file");
    }
    return {
      path: normalizedPath,
      media_type: mediaTypeFor(normalizedPath),
      content,
      encoding: "utf-8" as const,
      source: {
        repository: this.state.repository,
        ref: this.state.ref,
        commit: this.state.commit,
      },
    };
  }

  private async cloneCheckout() {
    const parent = dirname(this.options.cacheDir);
    await mkdir(parent, { recursive: true });
    const temporary = `${this.options.cacheDir}.clone-${randomUUID()}`;
    try {
      await this.cloneInto(temporary);
      await this.validateCheckoutAt(temporary);
      const metadata = await this.resolveMetadataAt(temporary, "fresh");
      await this.installCheckout(temporary, await pathExists(this.options.cacheDir));
      return metadata;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private async updateCheckout() {
    const temporary = `${this.options.cacheDir}.update-${randomUUID()}`;
    try {
      await this.cloneInto(temporary);
      await this.validateCheckoutAt(temporary);
      const metadata = await this.resolveMetadataAt(temporary, "fresh");
      await this.installCheckout(temporary, true);
      return metadata;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private async cloneInto(target: string) {
    const args = ["clone", "--depth", "1"];
    if (this.options.ref) args.push("--branch", this.options.ref, "--single-branch");
    args.push("--", this.repository, target);
    await this.run("git", args);
  }

  private async installCheckout(temporary: string, replacing: boolean) {
    if (!replacing) {
      await rename(temporary, this.options.cacheDir);
      return;
    }
    const backup = `${this.options.cacheDir}.previous-${randomUUID()}`;
    await rename(this.options.cacheDir, backup);
    try {
      await rename(temporary, this.options.cacheDir);
    } catch (error) {
      await rename(backup, this.options.cacheDir);
      throw error;
    }
    await rm(backup, { recursive: true, force: true }).catch(() => undefined);
  }

  private async recoverInterruptedInstall() {
    if (await pathExists(this.options.cacheDir)) return;
    const parent = dirname(this.options.cacheDir);
    const prefix = `${basename(this.options.cacheDir)}.previous-`;
    const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
        .map(async (entry) => {
          const path = join(parent, entry.name);
          return { path, modified: (await stat(path)).mtimeMs };
        }),
    );
    candidates.sort((left, right) => right.modified - left.modified);
    for (const candidate of candidates) {
      try {
        await this.validateCheckoutAt(candidate.path);
        await rename(candidate.path, this.options.cacheDir);
        return;
      } catch {
        // Try an older backup; invalid interrupted trees are never activated.
      }
    }
  }

  private async resolveMetadataAt(path: string, status: DocsStatus) {
    const [commit, ref, remote] = await Promise.all([
      this.run("git", ["rev-parse", "HEAD"], { cwd: path }),
      this.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: path,
      }),
      this.run("git", ["remote", "get-url", "origin"], { cwd: path }),
    ]);
    return {
      repository: sanitizeRepository(remote.stdout.trim()),
      ref: ref.stdout.trim() || null,
      commit: commit.stdout.trim() || null,
      status,
    };
  }

  private async validCheckout() {
    try {
      await this.validateCheckoutAt(this.options.cacheDir);
      return true;
    } catch {
      return false;
    }
  }

  private async docsRoot() {
    if (!this.cacheAllowed) {
      throw new ApiError(503, "DOCS_UNAVAILABLE", "Documentation is currently unavailable.");
    }
    if (this.state.status === "unavailable" && !(await pathExists(this.options.cacheDir))) {
      throw new ApiError(503, "DOCS_UNAVAILABLE", "Documentation is currently unavailable.");
    }
    try {
      return await this.validateCheckoutAt(this.options.cacheDir);
    } catch {
      throw new ApiError(503, "DOCS_UNAVAILABLE", "Documentation is currently unavailable.");
    }
  }

  private async safeFile(requestPath: string) {
    const normalized = normalizePath(requestPath);
    const root = await this.docsRoot();
    try {
      await rejectSymlinkSegments(root, normalized);
      const target = await realpath(resolve(root, normalized));
      if (!inside(root, target)) throw new Error("path escape");
      return target;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw notFound("Documentation file");
    }
  }

  private async validateCheckoutAt(checkoutPath: string) {
    const checkoutDetails = await lstat(checkoutPath);
    if (checkoutDetails.isSymbolicLink() || !checkoutDetails.isDirectory())
      throw new Error("checkout root must be a real directory");
    const gitDetails = await lstat(join(checkoutPath, ".git"));
    if (gitDetails.isSymbolicLink()) throw new Error("checkout metadata must not be a symlink");
    let root = checkoutPath;
    for (const segment of this.options.subdir.split("/")) {
      root = join(root, segment);
      const details = await lstat(root);
      if (details.isSymbolicLink() || !details.isDirectory())
        throw new Error("documentation root must contain no symlinks");
    }
    const checkout = await realpath(checkoutPath);
    const resolvedRoot = await realpath(root);
    if (!inside(checkout, resolvedRoot)) throw new Error("docs root escapes checkout");
    return resolvedRoot;
  }

  private async walk(root: string, directory: string, output: DocFile[], includeTitles: boolean) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.isSymbolicLink()) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await this.walk(root, full, output, includeTitles);
      else if (entry.isFile()) {
        const details = await stat(full);
        const path = relative(root, full).split(sep).join("/");
        if (!isPublicDocument(path) || details.size > this.options.maxFileBytes) continue;
        let content: string;
        try {
          content = await readUtf8(full, this.options.maxFileBytes);
        } catch {
          continue;
        }
        output.push({
          path,
          title: includeTitles ? titleFromContent(content, path) : null,
          media_type: mediaTypeFor(path),
          size: details.size,
        });
      }
    }
  }

  private matchesConfiguration(metadata: DocsMetadata) {
    if (canonicalRepository(metadata.repository) !== canonicalRepository(this.repository))
      return false;
    if (!this.options.ref) return true;
    return normalizeRef(metadata.ref) === normalizeRef(this.options.ref);
  }
}

async function rejectSymlinkSegments(root: string, path: string) {
  let current = root;
  for (const segment of path.split("/")) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("documentation path contains a symlink");
  }
}

function normalizePath(value: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ApiError(400, "INVALID_ARGUMENT", "Invalid documentation path.");
  }
  const path = decoded.replaceAll("\\", "/");
  const segments = path.split("/");
  if (
    !path ||
    isAbsolute(path) ||
    path.startsWith("/") ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".." || segment === ".git",
    )
  ) {
    throw new ApiError(400, "INVALID_ARGUMENT", "Invalid documentation path.");
  }
  return path;
}

function inside(root: string, target: string) {
  return target === root || target.startsWith(`${root}${sep}`);
}

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function titleFromContent(content: string, relativePath: string) {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return (
    heading ??
    relativePath
      .split("/")
      .at(-1)
      ?.replace(/\.[^.]+$/, "")
      .replaceAll(/[-_]/g, " ") ??
    null
  );
}

function countOccurrences(content: string, needle: string) {
  let count = 0;
  let offset = 0;
  while (offset <= content.length - needle.length) {
    const match = content.indexOf(needle, offset);
    if (match < 0) break;
    count += 1;
    offset = match + needle.length;
  }
  return count;
}

function sanitizeRepository(value: string) {
  const repository = new URL(value);
  repository.username = "";
  repository.password = "";
  return repository.toString();
}

function canonicalRepository(value: string) {
  return sanitizeRepository(value)
    .replace(/\/?(?:\.git)?\/?$/, "")
    .toLowerCase();
}

function normalizeRef(value: string | null) {
  return (value ?? "").replace(/^refs\/heads\//, "").replace(/^origin\//, "");
}

function mediaTypeFor(path: string) {
  return path === "meshtastic/example.yaml" ? "application/yaml" : "text/markdown";
}

function isPublicDocument(path: string) {
  return path.endsWith(".md") || path === "meshtastic/example.yaml";
}

function comparePaths(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readUtf8(path: string, maximum: number) {
  const content = await readFile(path);
  if (content.byteLength > maximum) {
    throw new ApiError(
      413,
      "INVALID_ARGUMENT",
      "Documentation file exceeds the configured size limit.",
    );
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(content);
}
