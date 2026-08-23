import { z } from "zod";

const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .max(64),
    message: z.string().min(1).max(1000),
    request_id: z.string().min(1).max(128).optional(),
  }),
});

export type RestJson = Record<string, unknown>;

export class RestError extends Error {
  readonly code: string;
  readonly requestId?: string;
  readonly status?: number;

  constructor(
    code: string,
    message: string,
    options: { requestId?: string; status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RestError";
    this.code = code;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.status !== undefined) this.status = options.status;
  }
}

export interface RestClient {
  get(path: string, options?: RestRequestOptions): Promise<RestJson>;
}

export interface RestRequestOptions {
  requestId?: string;
  signal?: AbortSignal;
}

export interface RestClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function fallbackError(status: number, docsRequest: boolean): RestError {
  if (status === 429) {
    return new RestError(
      "RATE_LIMIT_EXCEEDED",
      "The Meshat.se REST API rate limit was reached. Retry later.",
      { status },
    );
  }
  if (status === 404) {
    return new RestError("NOT_FOUND", "The requested resource was not found.", {
      status,
    });
  }
  if (status === 503 && docsRequest) {
    return new RestError(
      "DOCS_UNAVAILABLE",
      "Meshat.se documentation is temporarily unavailable.",
      { status },
    );
  }
  if (status === 502 || status === 503 || status === 504) {
    return new RestError("REST_UNAVAILABLE", "The Meshat.se REST API is temporarily unavailable.", {
      status,
    });
  }
  return new RestError(
    "REST_REQUEST_FAILED",
    `The Meshat.se REST API request failed with HTTP ${status}.`,
    { status },
  );
}

export function createRestClient(options: RestClientOptions = {}): RestClient {
  const configuredBaseUrl =
    options.baseUrl ?? process.env.REST_API_BASE_URL ?? "http://restful-api:8080";
  const baseUrl = new URL(configuredBaseUrl);
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("REST_API_BASE_URL must use http or https.");
  }
  if (baseUrl.username !== "" || baseUrl.password !== "") {
    throw new Error("REST_API_BASE_URL must not contain credentials.");
  }
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? Number(process.env.REST_API_TIMEOUT_MS ?? 8000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new Error("REST_API_TIMEOUT_MS must be an integer from 100 to 120000.");
  }
  const request = options.fetch ?? fetch;

  return {
    async get(path: string, requestOptions: RestRequestOptions = {}): Promise<RestJson> {
      if (!path.startsWith("/") || path.startsWith("//")) {
        throw new Error("REST paths must be absolute service paths.");
      }
      const url = new URL(`${baseUrl.origin}${basePath}${path}`);
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
      const signal = requestOptions.signal
        ? AbortSignal.any([timeoutController.signal, requestOptions.signal])
        : timeoutController.signal;

      try {
        const response = await request(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            "x-request-id": requestOptions.requestId ?? crypto.randomUUID(),
          },
          signal,
        });
        const body: unknown = await response.json().catch(() => undefined);
        if (!response.ok) {
          const parsed = errorEnvelopeSchema.safeParse(body);
          if (parsed.success) {
            throw new RestError(parsed.data.error.code, parsed.data.error.message, {
              requestId: parsed.data.error.request_id,
              status: response.status,
            });
          }
          throw fallbackError(response.status, path.startsWith("/v1/docs"));
        }
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          throw new RestError(
            "INVALID_REST_RESPONSE",
            "The Meshat.se REST API returned an invalid response.",
            { status: response.status },
          );
        }
        return body as RestJson;
      } catch (error) {
        if (error instanceof RestError) throw error;
        if (
          timeoutController.signal.aborted ||
          requestOptions.signal?.aborted ||
          (error instanceof Error && error.name === "AbortError")
        ) {
          if (requestOptions.signal?.aborted && !timeoutController.signal.aborted) {
            throw new RestError(
              "REQUEST_CANCELLED",
              "The Meshat.se REST API request was cancelled.",
              { cause: error },
            );
          }
          throw new RestError("REST_TIMEOUT", "The Meshat.se REST API request timed out.", {
            cause: error,
          });
        }
        throw new RestError("REST_UNAVAILABLE", "The Meshat.se REST API is unavailable.", {
          cause: error,
        });
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
