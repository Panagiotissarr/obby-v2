-- Schema for the Neon-backed /sync/v1 store. Idempotent: every statement is
-- IF NOT EXISTS, so `npm run migrate` (and the store's lazy ensure at cold
-- start) can both run it safely. See lib/store.js for the semantics this
-- implements.

-- Content-addressed file contents. Identical files (across paths, vaults
-- and history) share one row.
create table if not exists blobs (
  hash       text primary key,
  size       bigint not null,
  data       bytea  not null,
  created_at timestamptz not null default now()
);

-- In-flight chunked uploads. Vercel caps a request body at 4.5 MB, so a
-- bigger file arrives as several PUTs and is assembled here; parts are
-- dropped as soon as the blob is complete (or when they expire — blobs and
-- parts older than the grace window are swept by gc()).
create table if not exists blob_parts (
  hash       text   not null,
  idx        integer not null,
  total      integer not null,
  size       bigint not null,
  data       bytea  not null,
  created_at timestamptz not null default now(),
  primary key (hash, idx)
);

-- The vault's current file table. Deletions are tombstones (deleted = true),
-- not row removals — the manifest filters them out, but the row must survive
-- so a device that never saw the deletion can still be told about it.
create table if not exists files (
  vault_id   text   not null,
  path       text   not null,
  hash       text   not null,
  size       bigint not null,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (vault_id, path)
);

-- GC looks up "is this blob referenced by any file?" by hash.
create index if not exists files_hash_idx on files (hash);

-- One row per vault. `rev` is the manifest cursor: it is bumped exactly
-- once per successful commit, inside that commit's transaction, under the
-- row lock this UPDATE takes. Concurrent commits therefore serialize in
-- commit order, so a client that has seen cursor N can never miss a change
-- that produced a cursor <= N (the classic read-then-advance race).
create table if not exists vault_meta (
  vault_id   text primary key,
  rev        bigint not null default 0,
  updated_at timestamptz not null default now()
);
