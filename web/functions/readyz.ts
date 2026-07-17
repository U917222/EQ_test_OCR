interface Env {
  SCORING_API_URL?: string;
  SCORING_API_SECRET?: string;
  /** Temporary rolling-migration fallback. */
  FUNCTIONS_GAS_SECRET?: string;
}

const HEALTH_TIMEOUT_MS = 5_000;

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const startedAt = Date.now();
  const upstreamUrl = context.env.SCORING_API_URL || "";
  const hasSigningSecret = Boolean(
    context.env.SCORING_API_SECRET || context.env.FUNCTIONS_GAS_SECRET,
  );
  const configValid = Boolean(upstreamUrl) === hasSigningSecret;
  const upstream = !configValid
    ? { configured: true, ok: false, error: "incomplete_configuration" }
    : upstreamUrl
      ? await checkUpstream(upstreamUrl)
      : { configured: false };

  return new Response(
    JSON.stringify({
      ok: upstream.configured === false ? true : upstream.ok === true,
      service: "cheq-eqtest",
      upstream,
      config: {
        hasApiUrl: Boolean(upstreamUrl),
        hasSigningSecret,
      },
      elapsedMs: Date.now() - startedAt,
    }),
    {
      status: upstream.configured === false || upstream.ok === true ? 200 : 503,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
};

export const onRequest: PagesFunction<Env> = async () =>
  new Response(JSON.stringify({ ok: false, error: { code: "method_not_allowed", message: "Only GET is allowed for /readyz" } }), {
    status: 405,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

async function checkUpstream(apiUrl: string): Promise<Record<string, unknown>> {
  const url = new URL(apiUrl);
  url.pathname = "/readyz";
  url.search = "";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    return {
      configured: true,
      ok: response.ok,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      error: error instanceof Error && error.name === "AbortError" ? "timeout" : "request_failed",
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
