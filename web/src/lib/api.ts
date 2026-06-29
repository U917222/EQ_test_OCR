import { ApiErrorBody } from "@/lib/types";
import { DEMO, getDemoResponse } from "@/lib/demo";

type ApiSuccess<T> = T & { ok: true; idempotentReplay?: boolean };
type ApiFailure = { ok: false; error: ApiErrorBody };

const APP_PASSWORD_STORAGE_KEY = "cheq_app_password";

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(status: number, error: ApiErrorBody) {
    super(error.message);
    this.name = "ApiError";
    this.code = error.code;
    this.status = status;
  }
}

export async function postApi<TPayload extends object, TResponse>(
  action: string,
  payload: TPayload,
): Promise<TResponse> {
  if (DEMO) {
    return (await getDemoResponse(action, payload as Record<string, unknown>)) as TResponse;
  }

  const response = await fetch(`/api/${action}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...passwordHeader(),
    },
    body: JSON.stringify(payload),
  });

  let data: ApiSuccess<TResponse> | ApiFailure | null = null;
  try {
    data = (await response.json()) as ApiSuccess<TResponse> | ApiFailure;
  } catch {
    data = null;
  }

  if (!response.ok || !data || data.ok === false) {
    const fallback: ApiErrorBody = {
      code: response.status === 401 ? "unauthorized" : "internal",
      message: "APIリクエストに失敗しました。",
    };
    throw new ApiError(response.status, data && data.ok === false ? data.error : fallback);
  }

  const { ok: _ok, ...payloadResponse } = data;
  return payloadResponse as TResponse;
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

function passwordHeader(): Record<string, string> {
  const password = readSessionPassword();
  return password ? { "X-App-Password": password } : {};
}

export function rememberSharedPassword(password: string): void {
  try {
    sessionStorage.setItem(APP_PASSWORD_STORAGE_KEY, password);
  } catch {
    // Browser storage can be disabled; the session cookie remains as fallback.
  }
  try {
    localStorage.removeItem(APP_PASSWORD_STORAGE_KEY);
  } catch {
    // Ignore blocked persistent storage.
  }
}

function readSessionPassword(): string {
  try {
    return sessionStorage.getItem(APP_PASSWORD_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}
