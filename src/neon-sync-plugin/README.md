# Markport Neon Sync (Obsidian plugin)

Bidirectional sync between **any Obsidian vault** (desktop or mobile) and a
Markport `/sync/v1` backend — the Vercel + Neon deployment (e.g.
`https://notes.sarris.dev`). Same protocol, same decision rules as the
browser client (`src/client-mobile/sync/`), so a browser vault and an
Obsidian vault can share one server-side vault and all sync through the
same CAS/conflict semantics.

- **One file.** `main.js` + `manifest.json` — no build step, no bundler.
- **Mobile-safe.** Only `require('obsidian')`, `app.requestUrl`, WebCrypto and
  Vault adapter APIs. No Node `fs`/`crypto`, no Electron.
- **Pull → conflict → push**, exactly like `run-sync.js`: server wins at the
  original path, the losing side is preserved as
  `name.conflict-YYYYMMDDHHMMSS.ext` and pushed as a new file next sync.

## Install

### Desktop

1. Create the plugin folder in your vault:
   `<vault>/.obsidian/plugins/markport-neon-sync/`
2. Copy `main.js` and `manifest.json` into it (from this directory, or from
   the repo after checkout).
3. Obsidian → Settings → Community plugins → enable **Markport Neon Sync**.
   ("Restricted mode" must be off.)

### Mobile

1. Copy the same two files into `<vault>/.obsidian/plugins/markport-neon-sync/`
   by any route that reaches the phone (cloud-synced vault, cable copy, files
   app), **or** install once on desktop and sync the vault over first.
2. Open Obsidian → Settings → Community plugins → enable **Markport Neon
   Sync**. `manifest.json` declares `isDesktopOnly: false`, so it loads on
   Android/iOS too.

## Settings

| Setting | Meaning |
|---|---|
| **Server URL** | Origin of the deployment, e.g. `https://notes.sarris.dev` (no trailing path) |
| **Vault name** | The vault id on the server — the same name used in `/vault/<name>` links (`a-z 0-9 . _ -`, ≤ 64 chars) |
| **Password** | Claim/unlock password for that vault. Stored in the plugin's `data.json` so the token can refresh itself |
| **Token** | Advanced: paste a bearer token directly (an `mpv1.*` vault token or the operator's `SYNC_TOKEN`). **Connect** overwrites it |
| **Status** | **Check** — reads `GET /sync/v1/vaults/<name>` (is the vault claimed? is the stored token still valid?). **Connect** — exchanges the password for a fresh token. **Sync now** — runs one sync |
| **Auto-sync interval** | Minutes between automatic syncs; `0` = manual only (command palette `Sync now`, ribbon icon, or the settings button) |

### First run

1. Enter **Server URL** + **Vault name** + **Password**, press **Connect**.
   - If the vault name is *unclaimed*, your password **claims** it (first one
     wins; pick something ≥ 8 characters).
   - If it's already claimed, the password must *match* — otherwise 401.
2. Press **Sync now**. New files go up, new files come down; later syncs only
   transfer what changed (mtime + size cache, then sha-256).

The same claim/unlock endpoint backs the browser's `/vault/<name>` password
gate — a password set in Obsidian unlocks the same vault in the browser and
vice versa.

## How it talks to the server

```
POST /sync/v1/vaults/<name>   {password} → 200/201 {token}   (claim / unlock)
GET  /sync/v1/manifest        paginated listing (all pages or fail)
GET  /sync/v1/blob/<hash>     download (auto-ranges on 413)
POST /sync/v1/blobs/missing   which blobs the server lacks
PUT  /sync/v1/blob/<hash>     chunked upload (2 MB pieces, base64)
POST /sync/v1/commit          {changes, deletions} with baseHash CAS
```

- The exchanged token is an `mpv1.<name>.<expMs>.<sig>` vault token: valid
  **90 days**, usable **only** for that vault (403 on any other). The plugin
  reuses it until it's within 60 s of expiry, then silently re-unlocks with
  the stored password. If the server ever answers 401 on a stored token, it's
  discarded and re-obtained next sync.
- A manually pasted token works too: an `mpv1.*` token, or the operator's
  global `SYNC_TOKEN` (all vaults, no expiry — treat it like a root key).
- `planSync` in `main.js` is a **verbatim copy** of
  `src/client-mobile/sync/plan-sync.js`; `test/plan.test.js` runs the same
  decision-table vectors as the browser suite so the two can't drift.

## Conflicts

Hash-based optimistic concurrency — every push carries `baseHash` (what this
vault last synced for the path). The server applies a change only if nothing
moved under it; otherwise it reports its state and **nothing is overwritten**.
Both clients then follow one rule:

> Server wins at the original path; the local divergent content is preserved
> as `name.conflict-YYYYMMDDHHMMSS.ext` (or `-2`, `-3`, … if that name is
> taken) and pushed as a new file on the same sync's second push round.

Delete-vs-edit resolves the same way: the edit survives; a deletion of a file
the server still has unchanged is simply re-downloaded.

## Notes & limits

- Files under `.obsidian/`, `.trash/` and any dot-folder/dot-file are never
  synced (same filter as the browser client).
- Rate limit: the claim/unlock endpoint allows **10 attempts per minute per
  IP** (429 after that — the plugin reports it as "wait a minute").
- Server-side limits apply: 64 MiB per file (configurable), 1000 ops per
  commit batch (batches are automatic), 4.5 MB request bodies (chunked
  around).
- Against an older **pull-only** server (`src/sync-server/`), push endpoints
  answer `501`; the run finishes as a pull-only sync
  (`(server is pull-only)` in the notice) instead of failing.
- Conflict summary: after each sync a notice shows `↓ downloaded ↑ pushed
  deletions N · conflicts M`.

## Tests

```bash
cd src/neon-sync-plugin
node --test "test/*.test.js"     # 20 tests: decision table + helpers
```

The pure functions are attached to the exported class as statics so they run
under plain Node — `require('obsidian')` is guarded and falls back to stubs
outside Obsidian.
