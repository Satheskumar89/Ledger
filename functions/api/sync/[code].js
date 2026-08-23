// GET  /api/sync/:code  -> the stored ledger JSON for that code, or `null`
// PUT  /api/sync/:code  -> overwrite the stored ledger JSON for that code
//
// `code` is a self-chosen shared secret, not an account — anyone holding it
// can read or overwrite that ledger, the same trust model as a Google Docs
// link. That's the intended design for a no-login, personal/family tool;
// don't put anything more sensitive than the ledger itself behind it.

const CODE_RE = /^[a-z0-9-]{6,64}$/i;
const MAX_BODY_BYTES = 500_000; // a decade of entries is nowhere near this

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

export async function onRequestGet({ params, env }) {
  if (!CODE_RE.test(params.code)) return json({ error: 'Invalid sync code' }, 400);
  const raw = await env.LEDGER_SYNC.get(params.code);
  return new Response(raw ?? 'null', { headers: { 'content-type': 'application/json' } });
}

export async function onRequestPut({ params, env, request }) {
  if (!CODE_RE.test(params.code)) return json({ error: 'Invalid sync code' }, 400);

  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return json({ error: 'Payload too large' }, 413);

  try {
    JSON.parse(body);
  } catch (e) {
    return json({ error: 'Invalid JSON' }, 400);
  }

  await env.LEDGER_SYNC.put(params.code, body);
  return json({ ok: true });
}
