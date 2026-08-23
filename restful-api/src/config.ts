import { z } from "zod";
import { isIP } from "node:net";

const booleanValue = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");
const positiveInteger = (fallback: number, maximum = 1_000_000_000) =>
  z.coerce.number().int().positive().max(maximum).default(fallback);
const trustProxyValue = z
  .string()
  .default("false")
  .transform((value, context): boolean | string => {
    if (value === "true" || value === "false") return value === "true";
    const [address, prefix, extra] = value.split("/");
    const bits = Number(prefix);
    const family = isIP(address ?? "");
    const maximum = family === 4 ? 32 : family === 6 ? 128 : -1;
    if (
      extra !== undefined ||
      prefix === undefined ||
      !Number.isInteger(bits) ||
      bits < 0 ||
      bits > maximum
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be false, true, or one IPv4/IPv6 CIDR range",
      });
      return z.NEVER;
    }
    return value;
  });

const environmentSchema = z
  .object({
    REST_HOST: z.string().min(1).default("0.0.0.0"),
    REST_PORT: positiveInteger(8080, 65535),
    LOG_LEVEL: z.string().min(1).default("info"),
    TRUST_PROXY: trustProxyValue,
    CORS_ORIGINS: z.string().default("*"),
    API_RATE_LIMIT_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    API_RATE_LIMIT_MAX: positiveInteger(120, 100_000),
    API_RATE_LIMIT_WINDOW_MS: positiveInteger(60_000),
    API_BODY_LIMIT_BYTES: positiveInteger(65_536, 10_485_760),
    API_DEFAULT_LIMIT: positiveInteger(100, 200),
    API_MAX_LIMIT: positiveInteger(200, 500),
    MESSAGE_DEFAULT_LIMIT: positiveInteger(50, 200),
    MESSAGE_MAX_LIMIT: positiveInteger(200, 200),
    OBSERVER_ACTIVE_WINDOW_MS: positiveInteger(300_000, 86_400_000),
    DATABASE_HOST: z.string().min(1).default("meshdb"),
    DATABASE_PORT: positiveInteger(5432, 65535),
    DATABASE_NAME: z.string().min(1).default("meshcore"),
    DATABASE_USER: z.literal("meshcore_http").default("meshcore_http"),
    DATABASE_PASSWORD: z.string().min(1).optional(),
    DATABASE_SSL: booleanValue,
    DATABASE_POOL_MAX: positiveInteger(4, 5),
    DATABASE_STATEMENT_TIMEOUT_MS: positiveInteger(5_000, 30_000),
    DOCS_GIT_REPOSITORY: z
      .string()
      .url()
      .default("https://codeberg.org/meshat/hemsidan.git"),
    DOCS_GIT_REF: z.string().default(""),
    DOCS_CACHE_DIR: z.string().min(1).default("/var/lib/meshat-docs/repo"),
    DOCS_SUBDIR: z
      .string()
      .regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/)
      .default("docs"),
    DOCS_MAX_FILE_BYTES: positiveInteger(65_536, 65_536),
  })
  .superRefine((value, context) => {
    const repository = new URL(value.DOCS_GIT_REPOSITORY);
    if (repository.username || repository.password) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DOCS_GIT_REPOSITORY"],
        message: "must not contain username or password credentials",
      });
    }
  });

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const value = environmentSchema.parse(environment);
  if (value.API_DEFAULT_LIMIT > value.API_MAX_LIMIT) {
    throw new Error("API_DEFAULT_LIMIT must not exceed API_MAX_LIMIT");
  }
  if (value.MESSAGE_DEFAULT_LIMIT > value.MESSAGE_MAX_LIMIT) {
    throw new Error("MESSAGE_DEFAULT_LIMIT must not exceed MESSAGE_MAX_LIMIT");
  }
  return {
    host: value.REST_HOST,
    port: value.REST_PORT,
    logLevel: value.LOG_LEVEL,
    trustProxy: value.TRUST_PROXY,
    corsOrigins: value.CORS_ORIGINS,
    rateLimitEnabled: value.API_RATE_LIMIT_ENABLED,
    rateLimitMax: value.API_RATE_LIMIT_MAX,
    rateLimitWindowMs: value.API_RATE_LIMIT_WINDOW_MS,
    bodyLimitBytes: value.API_BODY_LIMIT_BYTES,
    defaultLimit: value.API_DEFAULT_LIMIT,
    maxLimit: value.API_MAX_LIMIT,
    messageDefaultLimit: value.MESSAGE_DEFAULT_LIMIT,
    messageMaxLimit: value.MESSAGE_MAX_LIMIT,
    observerActiveWindowMs: value.OBSERVER_ACTIVE_WINDOW_MS,
    database: {
      host: value.DATABASE_HOST,
      port: value.DATABASE_PORT,
      database: value.DATABASE_NAME,
      user: value.DATABASE_USER,
      password: value.DATABASE_PASSWORD,
      ssl: value.DATABASE_SSL,
      max: value.DATABASE_POOL_MAX,
      statement_timeout: value.DATABASE_STATEMENT_TIMEOUT_MS,
      application_name: "meshat-rest-api",
    },
    docs: {
      repository: value.DOCS_GIT_REPOSITORY,
      ref: value.DOCS_GIT_REF,
      cacheDir: value.DOCS_CACHE_DIR,
      subdir: value.DOCS_SUBDIR,
      maxFileBytes: value.DOCS_MAX_FILE_BYTES,
    },
  } as const;
}
