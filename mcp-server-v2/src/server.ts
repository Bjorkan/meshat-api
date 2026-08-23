import { isIP } from "node:net";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { hostHeaderValidation, originValidation } from "@modelcontextprotocol/fastify";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createRestClient, type RestClient } from "./rest.js";
import { createMcpServer, type OperationalLogger } from "./tools.js";

const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "[::1]", "mcp.meshat.se", "mcp-v2"];
const DEFAULT_ALLOWED_ORIGINS = ["localhost", "127.0.0.1", "[::1]", "mcp.meshat.se"];

interface RateLimitConfig {
  enabled: boolean;
  max: number;
  windowMs: number;
}

export interface BuildServerOptions {
  restClient?: RestClient;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  logger?: boolean;
  operationalLogger?: OperationalLogger;
  trustProxy?: boolean | string;
  rateLimit?: RateLimitConfig;
}

function configuredHostnames(
  value: string | undefined,
  fallback: string[],
  setting: string,
): string[] {
  const values = value === undefined ? fallback : value.split(",");
  const normalized = [...new Set(values.map((item) => item.trim()).filter(Boolean))];
  if (
    normalized.length === 0 ||
    normalized.some(
      (item) =>
        item.length > 253 || item === "*" || !/^(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)$/.test(item),
    )
  ) {
    throw new Error(
      `${setting} must be a comma-separated list of hostnames without schemes, ports, paths, or wildcards.`,
    );
  }
  return normalized;
}

function configuredBoolean(value: string | undefined, fallback: boolean, setting: string): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${setting} must be true or false.`);
}

function configuredInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  setting: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${setting} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

const MCP_RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function configuredReleaseId(value: string | undefined): string {
  if (value === undefined) return "2.0.0";
  if (!MCP_RELEASE_ID_PATTERN.test(value)) {
    throw new Error(
      "MCP_RELEASE_ID must start with an alphanumeric character and contain only letters, digits, dots, dashes, and underscores (max 64).",
    );
  }
  return value;
}

function configuredTrustProxy(value: string | undefined): boolean | string {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  const separator = value.lastIndexOf("/");
  const address = separator === -1 ? "" : value.slice(0, separator);
  const prefix = separator === -1 ? NaN : Number(value.slice(separator + 1));
  const version = isIP(address);
  const maximumPrefix = version === 4 ? 32 : version === 6 ? 128 : -1;
  if (
    maximumPrefix === -1 ||
    !Number.isSafeInteger(prefix) ||
    prefix < 0 ||
    prefix > maximumPrefix
  ) {
    throw new Error("MCP_TRUST_PROXY must be false, true, or one CIDR range.");
  }
  return value;
}

function environmentRateLimit(): RateLimitConfig {
  return {
    enabled: configuredBoolean(process.env.MCP_RATE_LIMIT_ENABLED, true, "MCP_RATE_LIMIT_ENABLED"),
    max: configuredInteger(process.env.MCP_RATE_LIMIT_MAX, 120, 1, 100_000, "MCP_RATE_LIMIT_MAX"),
    windowMs: configuredInteger(
      process.env.MCP_RATE_LIMIT_WINDOW_MS,
      60_000,
      1_000,
      3_600_000,
      "MCP_RATE_LIMIT_WINDOW_MS",
    ),
  };
}

function mcpError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const allowedHosts =
    options.allowedHosts ??
    configuredHostnames(process.env.MCP_ALLOWED_HOSTS, DEFAULT_ALLOWED_HOSTS, "MCP_ALLOWED_HOSTS");
  const allowedOrigins =
    options.allowedOrigins ??
    configuredHostnames(
      process.env.MCP_ALLOWED_ORIGINS,
      DEFAULT_ALLOWED_ORIGINS,
      "MCP_ALLOWED_ORIGINS",
    );
  const trustProxy = options.trustProxy ?? configuredTrustProxy(process.env.MCP_TRUST_PROXY);
  const rateLimitConfig = options.rateLimit ?? environmentRateLimit();
  const releaseId = configuredReleaseId(process.env.MCP_RELEASE_ID);
  const app = Fastify({
    logger: options.logger === false ? false : { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 64 * 1024,
    trustProxy,
  });
  const restClient = options.restClient ?? createRestClient();
  const operationalLogger = options.operationalLogger ?? app.log;

  void app.register(rateLimit, {
    global: rateLimitConfig.enabled,
    max: rateLimitConfig.max,
    timeWindow: rateLimitConfig.windowMs,
  });

  const mcpHandler = createMcpHandler(
    (context) =>
      createMcpServer(restClient, {
        requestId: context.requestInfo?.headers.get("x-request-id") ?? undefined,
        logger: operationalLogger,
      }),
    {
      legacy: "reject",
      onerror: (error) => app.log.error({ err: error }, "MCP request rejected"),
    },
  );
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => app.log.error({ err: error }, "MCP adapter failed"),
  });

  app.setErrorHandler((error, request, reply) => {
    const isMcp = request.url.split("?", 1)[0] === "/mcp";
    const errorCode = (error as { code?: string }).code;
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (isMcp && statusCode === 429) {
      return reply.code(429).send(mcpError(-32029, "Rate limit exceeded. Retry later."));
    }
    if (isMcp && errorCode === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return reply.code(415).send(mcpError(-32600, "Content-Type must be application/json."));
    }
    if (
      isMcp &&
      (errorCode === "FST_ERR_CTP_EMPTY_JSON_BODY" ||
        errorCode === "FST_ERR_CTP_INVALID_JSON_BODY" ||
        error instanceof SyntaxError)
    ) {
      return reply.code(400).send(mcpError(-32700, "Parse error"));
    }
    if (isMcp && errorCode === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send(mcpError(-32001, "Request body exceeds the allowed size."));
    }
    app.log.error({ err: error }, "Unhandled HTTP request error");
    if (isMcp) {
      return reply.code(500).send(mcpError(-32603, "Internal server error"));
    }
    return reply.code(500).send({
      error: { code: "INTERNAL_ERROR", message: "Internal server error." },
    });
  });

  app.get("/healthz", { config: { rateLimit: false } }, () => ({
    status: "ok",
    release_id: releaseId,
  }));
  app.get("/readyz", { config: { rateLimit: false } }, async (request, reply) => {
    try {
      const rest = await restClient.get("/readyz", {
        requestId: request.id,
      });
      const data = (rest.data ?? {}) as Record<string, unknown>;
      return {
        status: "ready",
        release_id: releaseId,
        rest: {
          release_id: typeof data.release_id === "string" ? data.release_id : null,
          schema_version: typeof data.schema_version === "number" ? data.schema_version : null,
          schema_hash: typeof data.schema_hash === "string" ? data.schema_hash : null,
        },
      };
    } catch {
      return reply.code(503).send({
        error: {
          code: "NOT_READY",
          message: "The Meshat.se REST API is unavailable.",
        },
      });
    }
  });

  app.after((error) => {
    if (error) throw error;
    const mcpValidation = [hostHeaderValidation(allowedHosts), originValidation(allowedOrigins)];
    app.route({
      method: ["GET", "DELETE", "PUT", "PATCH", "OPTIONS"],
      url: "/mcp",
      onRequest: mcpValidation,
      handler: async (_request, reply) =>
        reply
          .header("allow", "POST")
          .code(405)
          .send(mcpError(-32000, "Method not allowed. Use POST.")),
    });

    app.post(
      "/mcp",
      {
        onRequest: [
          ...mcpValidation,
          async (request, reply) => {
            const mediaType = request.headers["content-type"]
              ?.split(";", 1)[0]
              ?.trim()
              .toLowerCase();
            if (mediaType !== "application/json") {
              await reply
                .code(415)
                .send(mcpError(-32600, "Content-Type must be application/json."));
            }
          },
        ],
      },
      async (request, reply) => {
        request.raw.headers["x-request-id"] = request.id;
        reply.hijack();
        await nodeHandler(request.raw, reply.raw, request.body);
      },
    );
  });

  app.addHook("onClose", async () => mcpHandler.close());
  return app;
}
