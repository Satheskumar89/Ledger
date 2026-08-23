// Cloudflare Worker: serves the static Ledger app and the cloud-sync API.
//
// No accounts: a self-chosen code is the whole trust model, same as a
// Google Docs link — whoever holds it can read or overwrite that ledger.
// That's the intended design for a no-login, personal/family tool; don't
// put anything more sensitive than the ledger itself behind it.

const CODE_RE = /^[a-z0-9-]{6,64}$/i;
const MAX_BODY_BYTES = 500_000; // a decade of entries is nowhere near this

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

async function handleSync(request, env, code) {
  if (!CODE_RE.test(code)) return json({ error: 'Invalid sync code' }, 400);

  if (request.method === 'GET') {
    const raw = await env.LEDGER_SYNC.get(code);
    return new Response(raw ?? 'null', { headers: { 'content-type': 'application/json' } });
  }

  if (request.method === 'PUT') {
    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) return json({ error: 'Payload too large' }, 413);
    try {
      JSON.parse(body);
    } catch (e) {
      return json({ error: 'Invalid JSON' }, 400);
    }
    await env.LEDGER_SYNC.put(code, body);
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/sync\/([^/]+)$/);
    if (match) return handleSync(request, env, decodeURIComponent(match[1]));
    return env.ASSETS.fetch(request);
  }
};
