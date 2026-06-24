import { HttpError } from "./errors";
import { type Envelope, signEnvelope } from "./sign";

export interface GasEnv {
  FUNCTIONS_GAS_SECRET: string;
  GAS_API_URL?: string;
  SCORING_API_URL?: string;
}

const GAS_TIMEOUT_MS = 60_000;

export async function postToGas(env: GasEnv, envelope: Envelope): Promise<Response> {
  const apiUrl = env.SCORING_API_URL || env.GAS_API_URL;
  if (!apiUrl) {
    throw new HttpError(500, "internal", "Missing SCORING_API_URL or GAS_API_URL");
  }

  const signature = await signEnvelope(envelope, env.FUNCTIONS_GAS_SECRET);
  const url = new URL(apiUrl);
  url.searchParams.set("X-Signature", signature);
  url.searchParams.set("X-Timestamp", String(envelope.claims.ts));
  url.searchParams.set("X-Nonce", envelope.claims.nonce);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GAS_TIMEOUT_MS);

  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Signature": signature,
        "X-Timestamp": String(envelope.claims.ts),
        "X-Nonce": envelope.claims.nonce,
      },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new HttpError(502, "upstream", "GAS request timed out");
    }
    throw new HttpError(502, "upstream", "GAS request failed");
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new HttpError(502, "upstream", "GAS returned an invalid JSON response");
  }
}
