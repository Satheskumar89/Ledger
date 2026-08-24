// Cloudflare Worker: serves the static Ledger app and the cloud-sync API.
//
// No accounts: a self-chosen code is the whole trust model, same as a
// Google Docs link — whoever holds it can read or overwrite that ledger.
// That's the intended design for a no-login, personal/family tool; don't
// put anything more sensitive than the ledger itself behind it.

const CODE_RE = /^[a-z0-9-]{6,64}$/;
const MAX_BODY_BYTES = 500_000; // a decade of entries is nowhere near this

/* Every sync response must be uncacheable.
   A GET whose response gets cached — by the browser, by a corporate proxy, or
   by Cloudflare's own edge — hands the client an OLD snapshot. The client then
   compares that stale copy against its own state, concludes it is the newer
   side, and pushes over the genuinely newer cloud copy. That is the cheapest
   possible way to lose the latest version, and it needs no race and no clock
   skew to happen. The previous build sent no cache headers at all. */
const NO_STORE = {
  'content-type': 'application/json',
  'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
  'pragma': 'no-cache'
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: NO_STORE });
}

/* Payloads written before versioning existed have no `version`, and are
   treated as 0 so the client's migration path (see reconcileWithCloud) can
   tell "never versioned" from "version 1". Anything unparseable is also 0 —
   it cannot be ordered, so it must not be allowed to block a write. */
function versionOf(raw) {
  if (!raw) return 0;
  try {
    const v = JSON.parse(raw).version;
    return Number.isFinite(v) ? v : 0;
  } catch (e) {
    return 0;
  }
}

async function handleSync(request, env, rawCode) {
  /* Lowercased before it ever becomes a KV key. The regex used to carry /i,
     so `Otter-1234-ab` and `otter-1234-ab` both validated but addressed two
     DIFFERENT ledgers — a code typed with a capital, or arriving from a
     bookmarked #sync hash that had one, silently opened an empty ledger. */
  const code = rawCode.trim().toLowerCase();
  if (!CODE_RE.test(code)) return json({ error: 'Invalid sync code' }, 400);

  if (request.method === 'GET') {
    const raw = await env.LEDGER_SYNC.get(code);
    return new Response(raw ?? 'null', { headers: NO_STORE });
  }

  if (request.method === 'PUT') {
    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) return json({ error: 'Payload too large' }, 413);
    let incoming;
    try {
      incoming = JSON.parse(body);
    } catch (e) {
      return json({ error: 'Invalid JSON' }, 400);
    }

    /* Monotonic-version guard. The client claims `version = <what it last saw
       in the cloud> + 1`, so a write whose version is not ahead of what is
       actually stored means the client decided based on a copy that was already
       out of date — exactly the "old version replaced the latest" case. Reject
       it and hand back the current payload so the client can reconcile instead
       of guessing.

       LIMIT, and it is a real one: KV reads are eventually consistent (a read
       can serve a value up to ~60s stale), so this read can itself be behind
       and let a stale write through. It closes the common window — two devices
       minutes apart, a cached GET, a skewed clock — not the sub-minute one.
       Closing that fully needs a Durable Object to serialise the writes. */
    const force = new URL(request.url).searchParams.get('force') === '1';
    const current = await env.LEDGER_SYNC.get(code);
    const currentVersion = versionOf(current);
    const incomingVersion = Number.isFinite(incoming && incoming.version) ? incoming.version : 0;

    if (!force && current && incomingVersion <= currentVersion) {
      return json({
        error: 'Stale write',
        currentVersion,
        incomingVersion,
        current: JSON.parse(current)
      }, 409);
    }

    await env.LEDGER_SYNC.put(code, body);
    return json({ ok: true, version: incomingVersion });
  }

  /* Used by "Clear in cloud". Deliberately a real delete rather than writing
     an empty payload: an empty payload is still a version that every other
     device would then have to be told to adopt, whereas a missing key reads
     back as `null`, which every client already treats as "nothing stored under
     this code yet". */
  if (request.method === 'DELETE') {
    await env.LEDGER_SYNC.delete(code);
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
