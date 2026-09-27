# Vercel deployment (client-only + bidirectional sync)

Runs the static app **and** the `/sync/v1` protocol as Vercel serverless
functions, with vault sync state in **Neon Postgres**. The app itself is the
same browser-only build the Cloudflare deployment ships (OPFS vaults, no
server-side file storage) — this deployment adds the piece Cloudflare's static
host doesn't have: a sync endpoint devices can **push to and pull from**.

| | |
|---|---|
| App | static, built into `public/` (`npm run build`) |
| Sync | `/sync/v1/*` functions in `api/` (`vercel.json` rewrites `/sync/v1/:path*` → `/api/sync/v1/:path*`) |
| Proxy | `POST /api/proxy-request` (same allow-listed GitHub/obsidian.md proxy as the Cloudflare Worker) |
| Storage | Neon Postgres (`DATABASE_URL`) — blobs, per-vault file table, revision cursor |
| Auth | one `SYNC_TOKEN` (Bearer), fail-closed: unset → every sync request answers 503 |

## Why chunking exists (Vercel's 4.5 MB body cap)

Vercel caps **both** request and response bodies at 4.5 MB, so:

- **Uploads** are chunked: `PUT /sync/v1/blob/:hash` sends
  `{index, total, size, data}` (base64) 2 MB at a time; the store assembles,
  verifies the sha-256 against the URL's hash, then materializes the blob.
- **Downloads** are windowed: a blob over 3 MiB answered an *un-ranged* GET
  with `413`, which `remote-client.js` reads as "come back with
  `?start=&end=`" and reassembles in 2 MB ranges (`206` + `Content-Range`).
- **Manifest pages** paginate (`?after=&limit=`, `hasMore` in the response)
  — 2000 paths per page, so a large vault never builds one giant response.

Small vaults never notice any of this; it's invisible below the client.

## Conflicts

The protocol is hash-based optimistic concurrency: every push carries
`baseHash` (what that device last synced for the path), and the server applies
an operation only if its current effective hash still matches — otherwise it
reports its state back and **nothing is overwritten**. The client then follows
one rule (`plan-sync.js` / `run-sync.js`):

> **The server wins at the original path; the local divergent content is
> preserved as `name.conflict-YYYYMMDDHHMMSS.ext`** (unpushed until the next
> sync, which pushes it as a new file).

A delete-vs-edit resolves the same way: the edit survives, the deletion is
abandoned (or, if the local side had newer content, it becomes the conflict
copy). See `src/client-mobile/sync/plan-sync.js`'s header for the full
decision table.

Older pull-only servers (`src/sync-server/` v1) answer `501` on push
endpoints; the client detects that and finishes the run as a pull-only sync
(`pushSupported:false`) instead of failing.

## Setup

```bash
# 1. a Neon database (free tier is fine), then:
cd src/deployments/vercel
npm install
DATABASE_URL=postgres://… npm run migrate   # idempotent; also applied lazily on first use

# 2. build locally (vendor/ exists only on your machine — see repo README setup)
npm run build        # -> public/

# 3. link, configure, ship
vercel link --yes --project <name>
vercel env add SYNC_TOKEN   production --value <long-random-token> --yes
vercel env add DATABASE_URL production --value <neon-pooled-url>    --yes
vercel deploy --prod        # uploads public/ + api/, runs no build remotely
```

> **The Vercel project's Build Command must be empty** (Settings → Build
> Command, or `vercel project update <name> --build-command ""`). The build is
> local-only on purpose: `vendor/` (Obsidian's bundle) is gitignored, so it
> never exists on Vercel's builder and `npm run build` fails there by design —
> same rule as the Cloudflare deployment: build the artifact on your machine,
> ship the artifact. A Git-connected auto-build would need a vendor-download
> step first and is not supported out of the box. `vercel.json` therefore
> carries no `buildCommand` either.

Environment variables (Vercel → Project → Settings → Environment Variables):

| Var | Required | Meaning |
|---|---|---|
| `SYNC_TOKEN` | **yes** | Bearer token devices present. Unset → every `/sync/v1` request gets 503 (fail-closed on purpose) |
| `DATABASE_URL` | **yes** | Neon **pooled** connection string (`-pooler` host, `sslmode=require`) |
| `SYNC_STORE` | no | `postgres` (default) \| `memory` (local dev only — data dies with the process) |
| `SYNC_MAX_BLOB_BYTES` | no | largest single file, default 64 MiB |
| `SYNC_BLOB_FULL_GET_LIMIT` | no | un-ranged GET cap, default 3 MiB |
| `SYNC_PG_SSL_NO_VERIFY` | no | `1` → skip TLS verification (TLS-intercepting proxies only) |

## Point a device at it

Same localStorage config as the pull-sync protocol (there is no settings UI):

```js
localStorage.setItem('ow-sync:<vaultId>', JSON.stringify({
  baseUrl: 'https://your-app.vercel.app',
  token: 'the-SYNC_TOKEN-value',
  vault: 'home',          // optional — omits to the server's default vault
}));
```

A button appears in the file explorer (local OPFS vaults only, only when this
config exists — no config means no button and no network at all). Clicking it
runs the full pull → conflict → push cycle. Every device using the same
`vault` value shares one server-side vault; the local `<vaultId>`s don't have
to match each other.

## Scripts

```bash
npm run build      # scripts/build-assets.js -> public/  (same copies/markers as the Cloudflare build)
npm run dev        # local server: public/ + real /sync/v1 handlers + proxy (SYNC_STORE=memory, prints a dev token)
npm run migrate    # apply lib/schema.sql (idempotent)
npm test           # node --test — protocol, stores, proxy, adapter, fixture build
```

`npm run build` is a **Node port of the Cloudflare `scripts/build-assets.sh`**
— same sources, same markers, same cache-busting, deliberately kept in sync.
Differences: output is this package's `public/`, and there is no `_worker.js`
or `_headers` (functions live in `api/`, headers in `vercel.json`).

## Key files

| File | Purpose |
|------|---------|
| `vercel.json` | rewrites: `/sync/v1/*` → functions, `/starter` + `/vault/*` → SPA fallback |
| `lib/adapter.js` | Vercel `(req,res)` ⇄ web-standard `(Request)=>Response` bridge |
| `lib/auth.js` | Bearer token check (sha-256 + constant-time compare, fail-closed) |
| `lib/commit-rules.js` | the CAS/conflict rules — one implementation shared by both stores |
| `lib/store-pg.js` | Postgres store: batched SQL (≤5 round-trips per commit), lazy schema, GC |
| `lib/store-memory.js` | reference store (dev + tests) |
| `api/sync/v1/manifest.js` | paginated manifest + ETag cursor |
| `api/sync/v1/blob/[hash].js` | chunked upload / immutable download / byte ranges |
| `api/sync/v1/commit.js` | push: apply-or-conflict, `422 {hashes}` retry contract |
| `api/sync/v1/blobs/missing.js` | "which of these don't you have?" (skip re-uploads) |
| `api/sync/v1/{changes,live,deletions}.js` | `501` stubs (not needed by this client) |
| `api/proxy-request.js` | port of the Cloudflare `proxy-worker.js` (no Cache API) |
| `scripts/build-assets.js` | static build (port of the Cloudflare build script) |
| `scripts/dev.js` | local dev server, Vercel-shaped routing |

## Tests

```bash
npm test
```

- protocol: auth (fail-closed, empty-body 401), manifest pagination/ETag,
  blob chunking/ranges/`413`, commit CAS + conflict + `422`, validation limits
- `lib/store-memory.js` — the contract `lib/store-pg.js` must match
  (the PG store itself is exercised against a real database when
  `DATABASE_URL` points at one — it's opt-in, never runs against production
  config by accident)
- `api/proxy-request.js` — allow-list, SSRF/redirect guard, per-IP rate limit
  (outbound `fetch` is stubbed; no network in tests)
- `test/build-assets.test.js` — full fixture build in a temp dir (this repo
  ships without `vendor/`, so the test provides a stand-in)

## Keeping things in sync (on purpose)

- `scripts/build-assets.js` ⇄ `src/deployments/cloudflare/scripts/build-assets.sh`
  — same copy list and index.html markers; change both.
- `api/proxy-request.js` ⇄ `src/deployments/cloudflare/proxy-worker.js` ⇄
  `src/runtime-server/server/api/proxy.js` — one allow-list, three runtimes.
- The protocol surface mirrors `src/sync-server/` (the reference implementation):
  same auth, same manifest/blob shapes, same empty-body 401s — a client that
  works against one works against the other (pull-only `src/sync-server/`
  simply 501s the push endpoints, which the client treats as
  "no push support").
