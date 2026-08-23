/**
 * Typed boundaries for HTTP responses in tests.
 *
 * Fastify's inject().json() returns `any`; these helpers narrow it at a
 * single, explicit boundary so the rest of each test works with real types.
 */

export type ApiErrorShape = {
  code?: string;
  message?: string;
  request_id?: string;
};

export type OpenApiSchemaObject = {
  example?: unknown;
  default?: unknown;
  maximum?: number;
  properties?: Record<string, { required?: string[] }>;
};

export type OpenApiOperation = {
  summary?: string;
  description?: string;
  parameters?: Array<{
    name?: string;
    in?: string;
    description?: string;
    required?: boolean;
    schema?: OpenApiSchemaObject;
  }>;
  responses?: Record<
    string,
    {
      description?: string;
      content?: Record<string, { schema?: OpenApiSchemaObject }>;
    }
  >;
};

export type OpenApiDocument = {
  info?: { title?: string };
  components?: { securitySchemes?: unknown };
  paths?: Record<string, Record<string, OpenApiOperation | undefined>>;
};

/** Cast an injected JSON body to an expected shape (test-side boundary). */
export function jsonAs<T>(response: { json(): unknown }): T {
  return response.json() as T;
}

/** `data` payload of a standard single-resource envelope. */
export function payload<T>(response: { json(): unknown }): T {
  return (response.json() as { data: T }).data;
}

/** Stable error code access that fails assertions instead of crashing. */
export function errorCode(response: { json(): unknown }): string {
  return (response.json() as { error?: ApiErrorShape }).error?.code ?? "";
}

/** Full error object (code plus request id) of an error envelope. */
export function errorOf(response: { json(): unknown }): NonNullable<ApiErrorShape> {
  return (response.json() as { error?: ApiErrorShape }).error ?? { code: "" };
}
