import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const packageJson = require("../package.json") as { version?: string };

/** The single release-version source: this package's version field. */
export const VERSION = packageJson.version ?? "0.0.0";

export const SERVICE_NAME = "Meshat.se MCP-V2";

const BUILD_SHA_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * Deployment-injected build identity (optional).
 *
 * Set MCP_BUILD_SHA to the git commit the image was built from; never guess
 * it at runtime.
 */
export function resolveBuildSha(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  if (!BUILD_SHA_PATTERN.test(value)) {
    throw new Error("MCP_BUILD_SHA must be a git commit SHA of 7 to 40 hexadecimal characters.");
  }
  return value;
}
