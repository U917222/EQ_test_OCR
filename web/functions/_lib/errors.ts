export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "validation"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "upstream"
  | "internal"
  | "method_not_allowed";

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function errorResponse(status: number, code: ErrorCode, message: string): Response {
  return jsonResponse(
    {
      ok: false,
      error: { code, message },
    },
    status,
  );
}

export function responseFromError(error: unknown): Response {
  if (error instanceof HttpError) {
    return errorResponse(error.status, error.code, error.message);
  }

  return errorResponse(500, "internal", "Internal server error");
}
