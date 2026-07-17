import { verifyAccessJwt } from "../_lib/accessJwt";
import { errorResponse, HttpError, responseFromError } from "../_lib/errors";
import { dispatchD1 } from "../_lib/d1Backend";
import {
  assertScoringApiConfig,
  canDispatchScoringApi,
  dispatchScoringApi,
} from "../_lib/scoringApiBackend";
import { isAction, isWriteAction, type Action } from "../_lib/roles";

interface Env {
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  MVP_OPERATOR_EMAIL?: string;
  ALLOW_INSECURE_DEV_AUTH?: string;
  CHEQ_DB: D1Database;
  CHEQ_FILES?: R2Bucket;
  SCORING_API_URL?: string;
  SCORING_API_SECRET?: string;
  /** Temporary rolling-migration fallback. */
  FUNCTIONS_GAS_SECRET?: string;
  PDF_RENDER_URL?: string;
  PDF_RENDER_KEY?: string;
  OCR_API_URL?: string;
  OCR_API_KEY?: string;
}

type JsonBody = Record<string, unknown>;

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const action = getAction(context.params.route);
    assertJsonRequest(context.request);
    const body = await readJsonBody(context.request);
    const { email } = await verifyAccessJwt(context.request, context.env);
    getOperationId(action, body);
    assertScoringApiConfig(context.env);
    if (canDispatchScoringApi(context.env, action)) {
      return dispatchScoringApi(context.env, action, email, body);
    }
    const waitUntil = typeof context.waitUntil === "function" ? context.waitUntil.bind(context) : undefined;
    return dispatchD1(context.env, action, email, body, waitUntil);
  } catch (error) {
    // 内部例外(非 HttpError)と 5xx はログに残す。これが無いと本番で原因が追えない。
    if (!(error instanceof HttpError) || error.status >= 500) {
      console.error("[api] request failed:", error);
    }
    return responseFromError(error);
  }
};

export const onRequest: PagesFunction<Env> = async (context) => {
  if (context.request.method !== "POST") {
    return errorResponse(405, "method_not_allowed", "Only POST is allowed for /api/*");
  }

  return errorResponse(404, "not_found", "API route not found");
};

function getAction(routeParam: unknown): Action {
  const segments =
    Array.isArray(routeParam)
      ? routeParam
      : typeof routeParam === "string" && routeParam.length > 0
        ? [routeParam]
        : [];

  if (segments.length !== 1 || typeof segments[0] !== "string" || !isAction(segments[0])) {
    throw new HttpError(404, "not_found", "Unknown API action");
  }

  return segments[0];
}

function assertJsonRequest(request: Request): void {
  const contentType = request.headers.get("Content-Type") ?? "";
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpError(400, "validation", "Content-Type must be application/json");
  }
}

async function readJsonBody(request: Request): Promise<JsonBody> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new HttpError(400, "validation", "Request body must be valid JSON");
  }

  if (!isJsonObject(parsed)) {
    throw new HttpError(400, "validation", "Request body must be a JSON object");
  }

  return parsed;
}

function getOperationId(action: Action, body: JsonBody): string | null {
  const operationId = body.operationId;
  if (!isWriteAction(action)) {
    return null;
  }

  if (typeof operationId !== "string" || operationId.trim() === "") {
    throw new HttpError(400, "validation", "operationId is required for write actions");
  }

  return operationId;
}

function isJsonObject(value: unknown): value is JsonBody {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
