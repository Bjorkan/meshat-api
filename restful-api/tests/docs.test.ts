import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  DOCS_SEARCH_MAX_FILES,
  DOCS_SEARCH_MAX_TOTAL_BYTES,
  GitDocumentationService,
} from "../src/docs.js";
import { ApiError } from "../src/errors.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function fixture(maxFileBytes = 1024) {
  const root = join(tmpdir(), `meshat-docs-test-${randomUUID()}`);
  roots.push(root);
  const cacheDir = join(root, "repo");
  await mkdir(join(cacheDir, ".git"), { recursive: true });
  await mkdir(join(cacheDir, "docs", "meshcore"), { recursive: true });
  await writeFile(
    join(cacheDir, "docs", "meshcore", "guide.md"),
    "# MeshCore Guide\nUse repeaters safely.",
  );
  await writeFile(join(cacheDir, "outside.md"), "secret");
  return new GitDocumentationService({
    repository: "https://example.test/docs.git",
    ref: "main",
    cacheDir,
    subdir: "docs",
    maxFileBytes,
  });
}

describe("documentation cache safety", () => {
  it("shallow-clones a missing cache and records resolved metadata", async () => {
    const root = join(tmpdir(), `meshat-docs-clone-${randomUUID()}`);
    roots.push(root);
    const cacheDir = join(root, "repo");
    const calls: string[][] = [];
    const docs = new GitDocumentationService(
      {
        repository: "https://example.test/docs.git",
        ref: "main",
        cacheDir,
        subdir: "docs",
        maxFileBytes: 1024,
      },
      async (_command, args) => {
        calls.push(args);
        if (args[0] === "clone") {
          const target = args.at(-1)!;
          await mkdir(join(target, ".git"), { recursive: true });
          await mkdir(join(target, "docs"), { recursive: true });
          await writeFile(join(target, "docs", "index.md"), "# Index");
        }
        if (args[0] === "remote") return { stdout: "https://example.test/docs.git\n" };
        if (args.includes("--abbrev-ref")) return { stdout: "main\n" };
        if (args.includes("HEAD")) return { stdout: "abcdef\n" };
        return { stdout: "" };
      },
    );
    await docs.refresh();
    expect(calls[0]).toEqual([
      "clone",
      "--depth",
      "1",
      "--branch",
      "main",
      "--single-branch",
      "--",
      "https://example.test/docs.git",
      expect.stringContaining(".clone-"),
    ]);
    expect(docs.metadata()).toMatchObject({
      status: "fresh",
      ref: "main",
      commit: "abcdef",
    });
  });

  it("indexes and searches only regular files under docs", async () => {
    const docs = await fixture();
    expect(await docs.index()).toEqual([
      {
        path: "meshcore/guide.md",
        title: "MeshCore Guide",
        media_type: "text/markdown",
        size: 38,
      },
    ]);
    expect((await docs.search("repeaters", 20)).results[0]?.snippet).toContain("repeaters");
    expect((await docs.get("meshcore/guide.md")).encoding).toBe("utf-8");
  });

  it("exposes only lowercase Markdown and the exact Meshtastic YAML example as UTF-8", async () => {
    const docs = await fixture();
    const cache = (docs as unknown as { options: { cacheDir: string } }).options.cacheDir;
    await mkdir(join(cache, "docs", "meshtastic"), { recursive: true });
    await writeFile(join(cache, "docs", "meshtastic", "example.yaml"), "channel: LongFast\n");
    await writeFile(join(cache, "docs", "other.yaml"), "private: true\n");
    await writeFile(join(cache, "docs", "guide.txt"), "not public");
    await writeFile(join(cache, "docs", "guide.mdx"), "not public");
    await writeFile(join(cache, "docs", "UPPER.MD"), "not public");
    await writeFile(join(cache, "docs", "image.png"), new Uint8Array([0, 255]));
    await writeFile(join(cache, "docs", "invalid.md"), new Uint8Array([0xc3, 0x28]));

    expect((await docs.index()).map(({ path }) => path)).toEqual([
      "meshcore/guide.md",
      "meshtastic/example.yaml",
    ]);
    expect(await docs.get("meshtastic/example.yaml")).toMatchObject({
      media_type: "application/yaml",
      encoding: "utf-8",
      content: "channel: LongFast\n",
    });
    for (const path of [
      "other.yaml",
      "guide.txt",
      "guide.mdx",
      "UPPER.MD",
      "image.png",
      "invalid.md",
    ]) {
      await expect(docs.get(path), path).rejects.toMatchObject({
        statusCode: 404,
      });
    }
  });

  it("sorts a multi-file recursive index deterministically", async () => {
    const docs = await fixture();
    const cache = (docs as unknown as { options: { cacheDir: string } }).options.cacheDir;
    await writeFile(join(cache, "docs", "z-last.md"), "# Last");
    await writeFile(join(cache, "docs", "a-first.md"), "# First");
    expect((await docs.index()).map((file) => file.path)).toEqual([
      "a-first.md",
      "meshcore/guide.md",
      "z-last.md",
    ]);
    expect((await docs.index()).map((file) => file.path)).toEqual([
      "a-first.md",
      "meshcore/guide.md",
      "z-last.md",
    ]);
  });

  it("bounds aggregate search work and ranks matches without split allocation", async () => {
    const docs = await fixture(5 * 1024 * 1024);
    const cache = (docs as unknown as { options: { cacheDir: string } }).options.cacheDir;
    await writeFile(join(cache, "docs", "meshcore", "ranking.md"), "repeaters repeaters");
    expect((await docs.search("repeaters", 20)).results[0]?.path).toBe("meshcore/ranking.md");

    for (let index = 0; index < DOCS_SEARCH_MAX_FILES; index += 1) {
      await writeFile(join(cache, "docs", `a-${String(index).padStart(3, "0")}.md`), "no match");
    }
    await writeFile(join(cache, "docs", "z-match.md"), "bounded-only-marker");
    expect(await docs.search("bounded-only-marker", 20)).toMatchObject({
      query: "bounded-only-marker",
      limit: 20,
      returned: 0,
      total_matches: 0,
      scan_complete: false,
      truncated: true,
      results: [],
    });

    const byteDocs = await fixture(5 * 1024 * 1024);
    const byteCache = (byteDocs as unknown as { options: { cacheDir: string } }).options.cacheDir;
    await writeFile(join(byteCache, "docs", "a-large.md"), "x".repeat(DOCS_SEARCH_MAX_TOTAL_BYTES));
    await writeFile(join(byteCache, "docs", "z-byte-match.md"), "byte-only-marker");
    expect(await byteDocs.search("byte-only-marker", 20)).toMatchObject({
      returned: 0,
      total_matches: 0,
      scan_complete: false,
      truncated: true,
      results: [],
    });
  });

  it("reports exact search result and truncation metadata", async () => {
    const docs = await fixture();
    const cache = (docs as unknown as { options: { cacheDir: string } }).options.cacheDir;
    await writeFile(join(cache, "docs", "a.md"), "repeaters");
    await writeFile(join(cache, "docs", "b.md"), "repeaters");
    const result = await docs.search("  repeaters  ", 1);
    expect(result).toMatchObject({
      query: "repeaters",
      limit: 1,
      returned: 1,
      total_matches: 3,
      scan_complete: true,
      truncated: true,
    });
    expect(result.results).toHaveLength(1);
  });

  it("rejects traversal, encoded traversal, absolute paths, .git, and symlink escape", async () => {
    const docs = await fixture();
    const cache = (docs as unknown as { options: { cacheDir: string } }).options.cacheDir;
    await symlink(join(cache, "outside.md"), join(cache, "docs", "escape.md"));
    for (const path of [
      "../outside.md",
      "%2e%2e/outside.md",
      "/etc/passwd",
      ".git/config",
      "escape.md",
    ]) {
      await expect(docs.get(path), path).rejects.toBeInstanceOf(ApiError);
    }
    expect((await docs.index()).some((file) => file.path === "escape.md")).toBe(false);
  });

  it("rejects a symlinked intermediate documentation root", async () => {
    const root = join(tmpdir(), `meshat-docs-root-link-${randomUUID()}`);
    roots.push(root);
    const cacheDir = join(root, "repo");
    const external = join(root, "external");
    await mkdir(join(cacheDir, ".git"), { recursive: true });
    await mkdir(join(external, "docs"), { recursive: true });
    await writeFile(join(external, "docs", "guide.md"), "# Escaped");
    await symlink(external, join(cacheDir, "content"));
    const docs = new GitDocumentationService({
      repository: "https://example.test/docs.git",
      ref: "main",
      cacheDir,
      subdir: "content/docs",
      maxFileBytes: 1024,
    });
    await expect(docs.index()).rejects.toMatchObject({
      statusCode: 503,
      code: "DOCS_UNAVAILABLE",
    });
  });

  it("enforces maximum file size", async () => {
    const docs = await fixture(8);
    await expect(docs.get("meshcore/guide.md")).rejects.toMatchObject({
      statusCode: 413,
    });
    expect(await docs.index()).toEqual([]);
    expect(await docs.search("repeaters", 20)).toMatchObject({
      returned: 0,
      total_matches: 0,
      scan_complete: true,
      truncated: false,
      results: [],
    });
  });

  it("reports a valid cache as stale when isolated update fails", async () => {
    const base = await fixture();
    const options = (
      base as unknown as {
        options: ConstructorParameters<typeof GitDocumentationService>[0];
      }
    ).options;
    const docs = new GitDocumentationService(options, async (_command, args) => {
      if (args[0] === "clone") throw new Error("offline");
      if (args[0] === "remote") return { stdout: "https://example.test/docs.git\n" };
      if (args.includes("--abbrev-ref")) return { stdout: "main\n" };
      if (args.includes("HEAD")) return { stdout: "abcdef\n" };
      return { stdout: "" };
    });
    await docs.refresh();
    expect(docs.metadata()).toMatchObject({
      status: "stale",
      repository: "https://example.test/docs.git",
      ref: "main",
      commit: "abcdef",
    });
    expect((await docs.index()).length).toBe(1);
    expect((await docs.get("meshcore/guide.md")).content).toContain("Use repeaters safely");
  });

  it("keeps the known-good tree when an isolated update has a symlinked docs root", async () => {
    const base = await fixture();
    const options = (
      base as unknown as {
        options: ConstructorParameters<typeof GitDocumentationService>[0];
      }
    ).options;
    const docs = new GitDocumentationService(options, async (_command, args) => {
      if (args[0] === "clone") {
        const target = args.at(-1)!;
        await mkdir(join(target, ".git"), { recursive: true });
        await mkdir(join(target, "outside"), { recursive: true });
        await symlink(join(target, "outside"), join(target, "docs"));
      }
      if (args[0] === "remote") return { stdout: "https://example.test/docs.git\n" };
      if (args.includes("--abbrev-ref")) return { stdout: "main\n" };
      if (args.includes("HEAD")) return { stdout: "abcdef\n" };
      return { stdout: "" };
    });
    await docs.refresh();
    expect(docs.metadata().status).toBe("stale");
    expect((await docs.get("meshcore/guide.md")).content).toContain("Use repeaters safely");
  });

  it("keeps the known-good tree when updated Git metadata cannot be resolved", async () => {
    const base = await fixture();
    const options = (
      base as unknown as {
        options: ConstructorParameters<typeof GitDocumentationService>[0];
      }
    ).options;
    const docs = new GitDocumentationService(options, async (_command, args, commandOptions) => {
      if (args[0] === "clone") {
        const target = args.at(-1)!;
        await mkdir(join(target, ".git"), { recursive: true });
        await mkdir(join(target, "docs"), { recursive: true });
        await writeFile(join(target, "docs", "replacement.md"), "# Replacement");
        return { stdout: "" };
      }
      if (commandOptions?.cwd?.includes(".update-")) throw new Error("bad metadata");
      if (args[0] === "remote") return { stdout: "https://example.test/docs.git\n" };
      if (args.includes("--abbrev-ref")) return { stdout: "main\n" };
      return { stdout: "abcdef\n" };
    });
    await docs.refresh();
    expect(docs.metadata().status).toBe("stale");
    expect((await docs.get("meshcore/guide.md")).content).toContain("Use repeaters safely");
    await expect(docs.get("replacement.md")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("recovers a known-good backup left by an interrupted swap", async () => {
    const base = await fixture();
    const options = (
      base as unknown as {
        options: ConstructorParameters<typeof GitDocumentationService>[0];
      }
    ).options;
    await rename(options.cacheDir, `${options.cacheDir}.previous-interrupted`);
    const docs = new GitDocumentationService(options, async (_command, args) => {
      if (args[0] === "clone") throw new Error("offline");
      if (args[0] === "remote") return { stdout: "https://example.test/docs.git\n" };
      if (args.includes("--abbrev-ref")) return { stdout: "main\n" };
      return { stdout: "abcdef\n" };
    });
    await docs.refresh();
    expect(docs.metadata().status).toBe("stale");
    expect((await docs.get("meshcore/guide.md")).content).toContain("Use repeaters safely");
  });

  it("rejects repository credentials without reflecting them", () => {
    expect(
      () =>
        new GitDocumentationService({
          repository: "https://user:super-secret@example.test/docs.git",
          ref: "",
          cacheDir: "/tmp/unused",
          subdir: "docs",
          maxFileBytes: 1024,
        }),
    ).toThrowError(/^Documentation repository URL must not contain credentials$/);
  });

  it("does not serve or misattribute a cache from a newly changed repository", async () => {
    const base = await fixture();
    const oldOptions = (
      base as unknown as {
        options: ConstructorParameters<typeof GitDocumentationService>[0];
      }
    ).options;
    const docs = new GitDocumentationService(
      { ...oldOptions, repository: "https://new.example.test/docs.git" },
      async (_command, args) => {
        if (args[0] === "clone") throw new Error("new repository offline");
        if (args[0] === "remote") return { stdout: "https://example.test/docs.git\n" };
        if (args.includes("--abbrev-ref")) return { stdout: "main\n" };
        return { stdout: "abcdef\n" };
      },
    );
    await expect(docs.refresh()).rejects.toThrow("new repository offline");
    expect(docs.metadata()).toMatchObject({
      status: "unavailable",
      repository: "https://new.example.test/docs.git",
      commit: null,
    });
    await expect(docs.index()).rejects.toMatchObject({
      statusCode: 503,
      code: "DOCS_UNAVAILABLE",
    });

    const changedRef = new GitDocumentationService(
      { ...oldOptions, ref: "other-branch" },
      async (_command, args) => {
        if (args[0] === "clone") throw new Error("new ref offline");
        if (args[0] === "remote") return { stdout: "https://example.test/docs.git\n" };
        if (args.includes("--abbrev-ref")) return { stdout: "main\n" };
        return { stdout: "abcdef\n" };
      },
    );
    await expect(changedRef.refresh()).rejects.toThrow("new ref offline");
    expect(changedRef.metadata().status).toBe("unavailable");
  });

  it("remains unavailable when initial clone fails", async () => {
    const root = join(tmpdir(), `meshat-docs-failed-${randomUUID()}`);
    roots.push(root);
    const docs = new GitDocumentationService(
      {
        repository: "https://example.test/docs.git",
        ref: "",
        cacheDir: join(root, "repo"),
        subdir: "docs",
        maxFileBytes: 1024,
      },
      async () => {
        throw new Error("offline");
      },
    );
    await expect(docs.refresh()).rejects.toThrow("offline");
    expect(docs.metadata().status).toBe("unavailable");
    await expect(docs.index()).rejects.toMatchObject({
      statusCode: 503,
      code: "DOCS_UNAVAILABLE",
    });
  });
});
