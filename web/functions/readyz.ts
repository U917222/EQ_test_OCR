export const onRequestGet: PagesFunction = async () => {
  const startedAt = Date.now();

  return new Response(
    JSON.stringify({
      ok: true,
      service: "cheq-eqtest",
      elapsedMs: Date.now() - startedAt,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
};

export const onRequest: PagesFunction = async () =>
  new Response(JSON.stringify({ ok: false, error: { code: "method_not_allowed", message: "Only GET is allowed for /readyz" } }), {
    status: 405,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
