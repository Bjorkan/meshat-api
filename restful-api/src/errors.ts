export type ErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_CURSOR"
  | "INVALID_PUBLIC_KEY"
  | "INVALID_IATA"
  | "NOT_FOUND"
  | "RATE_LIMIT_EXCEEDED"
  | "DOCS_UNAVAILABLE"
  | "DATABASE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (resource = "Resource") =>
  new ApiError(404, "NOT_FOUND", `${resource} was not found.`);
