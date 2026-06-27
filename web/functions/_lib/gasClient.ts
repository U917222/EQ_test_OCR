import { HttpError } from "./errors";
import { type Envelope, signEnvelope } from "./sign";

export interface GasEnv {
  FUNCTIONS_GAS_SECRET: string;
  GAS_API_URL?: string;
  SCORING_API_URL?: string;
}

const GAS_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export async function postToGas(env: GasEnv, envelope: Envelope): Promise<Response> {
  const apiUrl = env.SCORING_API_URL || env.GAS_API_URL;
  if (!apiUrl) {
    throw new HttpError(500, "internal", "Missing SCORING_API_URL or GAS_API_URL");
  }

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const attemptEnvelope = attempt === 1 ? envelope : freshEnvelope(envelope);
    const signature = await signEnvelope(attemptEnvelope, env.FUNCTIONS_GAS_SECRET);
    const url = new URL(apiUrl);
    url.searchParams.set("X-Signature", signature);
    url.searchParams.set("X-Timestamp", String(attemptEnvelope.claims.ts));
    url.searchParams.set("X-Nonce", attemptEnvelope.claims.nonce);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GAS_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-Signature": signature,
          "X-Timestamp": String(attemptEnvelope.claims.ts),
          "X-Nonce": attemptEnvelope.claims.nonce,
        },
        body: JSON.stringify(attemptEnvelope),
        signal: controller.signal,
      });

      if (!shouldRetryStatus(response.status) || attempt === MAX_ATTEMPTS) {
        return response;
      }

      console.warn(JSON.stringify({
        event: "scoring_api_retry",
        action: envelope.claims.action,
        attempt,
        status: response.status,
      }));
      await sleep(retryDelayMs(attempt));
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS) break;
      console.warn(JSON.stringify({
        event: "scoring_api_retry",
        action: envelope.claims.action,
        attempt,
        error: error instanceof Error ? error.name : "unknown",
      }));
      await sleep(retryDelayMs(attempt));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (lastError instanceof Error && lastError.name === "AbortError") {
    throw new HttpError(502, "upstream", "GAS request timed out");
  }
  throw new HttpError(502, "upstream", "GAS request failed");
}

export async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new HttpError(502, "upstream", "GAS returned an invalid JSON response");
  }
}

function freshEnvelope(envelope: Envelope): Envelope {
  return {
    ...envelope,
    claims: {
      ...envelope.claims,
      ts: Math.floor(Date.now() / 1000),
      nonce: randomHex(16),
    },
  };
}

function shouldRetryStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

function retryDelayMs(attempt: number): number {
  const jitter = crypto.getRandomValues(new Uint32Array(1))[0] % 100;
  return RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
