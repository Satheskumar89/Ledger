# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

There is **no build step, no package.json, no test suite, and no CI**. The app is three
hand-written files served as-is.

```bash
npx wrangler dev      # Worker + static assets on localhost (sync API works)
npx wrangler deploy   # deploy to the "ledger" Worker
```

To eyeball a pure UI change without Cloudflare, any static server over `public/` is enough —
asset paths are sibling-relative precisely so this works:

```bash
cd public && python3 -m http.server 8934
```

Cloud sync is the only thing that needs the Worker; entries, repeats and rendering all run
off `localStorage` alone.

Commits in this repo are prefixed with a ticket id: `CPM-<number> <description>`.

## Architecture

Three files, no framework, no dependencies:

| File | Role |
|---|---|
| `public/index.html` | All markup **and** all application JS, in one inline `<script>` (~3.5k lines) |
| `public/styles.css` | Every style, plus the design-token system |
| `src/index.js` | Cloudflare Worker: sync API + static asset passthrough |

The Worker routes `/api/sync/:code` to KV (binding `LEDGER_SYNC`) and hands everything else to
`env.ASSETS`. That's its entire job.

### Cloud sync — read this before touching anything sync-related

The trust model is deliberately account-free: **a self-chosen code is the whole credential**,
like a Google Docs link. Codes are lowercased on both client and server, or the same code typed
with a capital would address a different ledger.

Ordering between a device and the cloud is done with a **version counter plus a dirty flag —
never timestamps.** An earlier build compared `updatedAt` and lost data to clock skew; the
comments throughout are the record of why. Two localStorage keys carry the state:

- `ledger_sync_base_v1` — which cloud version this device's data is derived from
- `ledger_sync_dirty_v1` — whether local edits haven't reached the cloud yet

`reconcileWithCloud()` is the decision table built on those two, and the cases are not
interchangeable:

- cloud ahead **and** dirty → **stop and say so.** Both sides moved; neither can be applied
  without destroying the other. The user resolves it with the explicit Pull/Push buttons
  (which send `?force=1`).
- cloud ahead, clean → adopt the cloud copy.
- cloud not ahead, dirty → push, claiming `cloudVersion + 1`.
- cloud behind our base → do nothing (almost certainly a stale eventually-consistent read).

Server-side, `PUT` rejects any write whose version isn't strictly ahead of what's stored,
returning **409 with the current payload** so the client reconciles instead of guessing.

Two constraints that look cosmetic and are not:

- **Every sync response must be uncacheable** (`NO_STORE` in `src/index.js`). A cached GET hands
  a client a stale snapshot, which it then concludes is the newer side and pushes over the
  genuinely newer cloud copy. This is the cheapest possible way to lose data.
- **KV reads are eventually consistent (~60s)**, so the version guard closes the common
  multi-minute window, not the sub-minute one. Fully closing it needs a Durable Object to
  serialise writes. Known and accepted — don't "fix" it with timestamps.

The sync code lives in **both** `localStorage` and the URL hash (`#sync=…`). The hash is the
real recovery path: a storage wipe takes the localStorage copy with it, so a bookmark is what
survives.

### Data model

All persisted under `ledger_*` keys via `safeStorage`, which silently falls back to an
in-memory object when `localStorage` throws (private mode, blocked storage).

**Entries** (`ledger_entries_v2`) store `category` as a plain string. Renaming a category in
`CATEGORIES` would orphan every entry already filed under the old name, so renames go in
`RENAMED_CATEGORIES` and are rewritten on read — this also catches old names arriving via
imported backups.

**Repeats** (`ledger_repeats_v1`) are **templates, never entries.** Nothing reaches the ledger
without being confirmed; a real entry carrying `repeatId` + `occ` is the record that one
occurrence happened. Amounts live in an ascending `rates: [{from, amount}]` array rather than a
single field, so a rent rise *appends* a rate — already-confirmed months stay true and a rise
can be dated ahead of time.

`saveEntries()` / `saveRepeats()` must keep reporting write failures. Quota errors were once
swallowed, which made a failed write look successful and the entry silently vanish.

### CSS token system

`styles.css` opens with the authoritative explanation; the short version is three layers in
dependency order:

1. `--ios-*` — Apple system primitives. **Not** referenced by components.
2. semantic — `--ink`, `--accent`, `--card`, `--expense`… what the ~1,900 `var()` calls read.
3. scales — spacing, type, tracking, radius, motion.

**Dark mode works by redefining Layer 1 only.** The semantic names resolve through the
primitives, so they need no dark block of their own — don't reintroduce one.

Colours split by *use*: `--expense` / `--income` are text-safe, `--expense-fill` /
`--income-fill` are for fills, and `--accent` / `--accent-text` split the same way for contrast
reasons documented inline. Per-category colour comes from `--cat-*` selected by a
`data-cat="<slug>"` attribute, so it can follow light/dark — but the hex on `CATEGORIES` in the
JS is still written into every entry and repeat and must stay, because exported backups carry it.

Two rules from the file header worth repeating: raw px values are converted to tokens
**opportunistically, per component** (a mechanical find/replace would entangle unrelated
scales that share a number), and `clamp()`, `env(safe-area-inset-*)`, `100dvh`, the calendar's
1px grid gaps, `perspective: 1200px` and the calc sheet's `flex: 0 0 50%` are load-bearing math
that must never be tokenized.

## Gotchas

- **Bump `?v=N` on the `styles.css` link in `index.html` whenever `styles.css` changes.**
  `index.html` is always revalidated, so a new HTML pointing at a new URL is what keeps the pair
  from going out of sync in a cache. The icon links carry the same `?v=`.
- The `theme-color` meta tags must track `--ios-grouped`; a stale value shows as a seam above
  the page.
- `.face.back` (the balance summary) is `position: absolute; inset: 0` inside a container with
  `overflow: hidden`, so **the calendar on the front face dictates its height** — a 4-row month
  gives only ~168px. The CSS carries a running height budget; re-check the sum before adding a
  line to that face.
- Any figure animated by `countTo()` needs `font-variant-numeric: tabular-nums`, or the digits
  jitter horizontally every frame.
- The blanket `prefers-reduced-motion` rule in CSS cannot reach a `requestAnimationFrame` loop,
  a `setTimeout`, or `navigator.vibrate` — JS paths must consult `reduceMotion()` directly.
- This is an iOS-first PWA: scroll locking, keyboard-aware overlays and safe-area insets are all
  hand-managed, and several rules exist to work around specific iOS behaviour. The inline
  comments explain which; read them before simplifying.
