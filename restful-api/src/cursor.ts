import { createHash } from "node:crypto";
import { ApiError } from "./errors.js";

type CursorPayload = {
  v: 1;
  resource: string;
  query: string;
  key: [string, string];
};

export function queryFingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("base64url");
}

export function encodeCursor(
  resource: string,
  query: unknown,
  key: [string, string],
): string {
  validateKey(resource, query, key);
  const payload: CursorPayload = {
    v: 1,
    resource,
    query: queryFingerprint(query),
    key,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeCursor(
  cursor: string | undefined,
  resource: string,
  query: unknown,
): [string, string] | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<CursorPayload>;
    if (
      value.v !== 1 ||
      value.resource !== resource ||
      value.query !== queryFingerprint(query) ||
      !Array.isArray(value.key) ||
      value.key.length !== 2 ||
      value.key.some((part) => typeof part !== "string")
    ) {
      throw new Error("cursor mismatch");
    }
    const key = value.key as [string, string];
    validateKey(resource, query, key);
    return key;
  } catch {
    throw new ApiError(
      422,
      "INVALID_CURSOR",
      "The cursor is invalid for this query.",
    );
  }
}

function validateKey(resource: string, query: unknown, key: [string, string]) {
  const sort = readSort(query);
  const publicKeyResources = new Set(["nodes", "observers", "region-nodes"]);
  const hashResources = new Set(["packets"]);
  const logicalIdResources = new Set(["messages"]);
  const numericIdResources = new Set([
    "node-adverts",
    "node-sightings",
    "node-telemetry",
    "observer-metrics",
    "packet-observations",
    "telemetry",
    "traces",
  ]);
  if (
    !publicKeyResources.has(resource) &&
    !hashResources.has(resource) &&
    !logicalIdResources.has(resource) &&
    !numericIdResources.has(resource)
  ) {
    throw new Error("unknown cursor resource");
  }
  const naturalSort =
    (resource === "nodes" && (sort === "name" || sort === "role")) ||
    (resource === "observers" && sort === "name");
  if (naturalSort) {
    if (key[0].length > 200 || /[\u0000-\u001f]/.test(key[0]))
      throw new Error("invalid natural key");
  } else if (!isUnsignedInteger(key[0])) {
    throw new Error("invalid numeric sort key");
  }
  if (logicalIdResources.has(resource)) {
    if (!/^lp_[0-9a-fA-F]{64}$/.test(key[1]))
      throw new Error("invalid logical message identity");
  } else if (publicKeyResources.has(resource) || hashResources.has(resource)) {
    if (!/^[0-9a-fA-F]{64}$/.test(key[1]))
      throw new Error("invalid natural identity");
  } else if (!isUnsignedInteger(key[1])) {
    throw new Error("invalid numeric identity");
  }
}

function readSort(query: unknown) {
  if (!query || typeof query !== "object") throw new Error("invalid query");
  const sort = (query as { sort?: unknown }).sort;
  if (typeof sort !== "string") throw new Error("invalid cursor sort");
  return sort;
}

function isUnsignedInteger(value: string) {
  return /^(0|[1-9]\d*)$/.test(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
