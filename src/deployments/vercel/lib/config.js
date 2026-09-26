// Environment-driven configuration for the sync functions.
//
// Vercel env vars (Project → Settings → Environment Variables):
//   SYNC_TOKEN         required. Bearer token devices must present.
//   DATABASE_URL       required unless SYNC_STORE=memory. Neon pooled
//                      connection string (host with `-pooler`, sslmode=require).
//   SYNC_STORE         'postgres' (default) | 'memory'.
//                      memory is for local dev ONLY: it holds everything in
//                      the process and vanishes on restart. Never set it on
//                      a deployment — sync would silently lose data.
//   SYNC_MAX_BLOB_BYTES  optional, default 64 MiB. Largest single file the
//                      server will assemble and store.
//
// Failing closed: mode defaults to postgres, and postgres without
// DATABASE_URL refuses every sync request instead of quietly serving an
// empty in-memory vault.

const MiB = 1024 * 1024;

export function getSyncToken() {
  return process.env.SYNC_TOKEN || '';
}

export function getDatabaseUrl() {
  return process.env.DATABASE_URL || '';
}

export function getStoreMode() {
  return process.env.SYNC_STORE || 'postgres';
}

export function getMaxBlobBytes() {
  const raw = Number(process.env.SYNC_MAX_BLOB_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 64 * MiB;
}

// Manifest page size. Vercel caps request AND response bodies at 4.5 MB, so
// a page must stay well under that even for near-max-length paths
// (2000 × (1024-byte path + ~90 bytes) ≈ 2.2 MB).
export const MANIFEST_DEFAULT_LIMIT = 2000;
export const MANIFEST_MAX_LIMIT = 3000;

// Per-request ceilings (Vercel's 4.5 MB body limit is the real constraint).
export const MAX_COMMIT_OPS = 3000;
export const MAX_HASH_BATCH = 5000;
export const MAX_PATH_LENGTH = 1024;

// Largest blob served in ONE response (default 3 MiB). Vercel caps a
// response at 4.5 MB, so an un-ranged GET over this size is refused with
// 413 instead of being truncated by the platform — clients
// (remote-client.js) read 413 as "come back with ?start=&end=" and
// reassemble in 2 MB windows. Overridable for tests / tuning via
// SYNC_BLOB_FULL_GET_LIMIT.
export function getBlobFullGetLimit() {
  const raw = Number(process.env.SYNC_BLOB_FULL_GET_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3 * 1024 * 1024;
}
