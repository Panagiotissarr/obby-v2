// Live-Postgres contract tests for lib/store-pg.js - the store as it runs
// against a real Neon database, not a mock. Opt-in: every test is skipped
// unless DATABASE_URL is set, so the default local suite needs no database.
//
// Each run uses a unique throwaway vault id, so a real synced vault's
// manifest is never touched. Blobs written here are content-addressed rows
// that nothing references; the after() hook's gc() sweeps them.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPgStore } from '../lib/store-pg.js';
import { StoreError } from '../lib/errors.js';
import { sha256Hex } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL && 'DATABASE_URL not set';
const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const vault = `test-pg-${run}`;

let store;

before(async () => {
  if (DATABASE_URL) store = await createPgStore(DATABASE_URL);
});

after(async () => {
  if (store) {
    await store.gc();
    // Claims are real rows in vault_claims - remove this run's throwaway
    // names so repeated live runs don't accumulate garbage.
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { sslmode: 'require' } });
    await client.connect();
    try {
      await client.query(`delete from vault_claims where name like $1`, [`${vault}%`]);
    } finally {
      await client.end();
    }
    await store.close();
  }
});

test('manifest: empty vault is cursor "0", no entries, hasMore false', { skip: SKIP }, async () => {
  const m = await store.getManifest(vault, {});
  assert.deepEqual(m, { cursor: '0', entries: [], hasMore: false });
});

test('manifest: commits apply, tombstones hide, cursor bumps once per commit', { skip: SKIP }, async () => {
  await store.commit(vault, [
    { path: 'b.md', hash: 'b'.repeat(64), size: 2, baseHash: null },
    { path: 'a.md', hash: 'a'.repeat(64), size: 1, baseHash: null },
    { path: 'c.md', hash: 'c'.repeat(64), size: 3, baseHash: null },
  ], []);
  await store.commit(vault, [], [{ path: 'c.md', baseHash: 'c'.repeat(64) }]);

  const m = await store.getManifest(vault, {});
  assert.deepEqual(m.entries.map((e) => e.path), ['a.md', 'b.md']);
  assert.equal(m.entries[0].hash, 'a'.repeat(64));
  assert.equal(m.entries[0].size, 1);
  assert.equal(m.cursor, '2');
  assert.equal(m.hasMore, false);
});

test('manifest: pagination with after + limit, exclusive cursor', { skip: SKIP }, async () => {
  const pagedVault = `${vault}-paged`;
  const changes = ['a', 'b', 'c', 'd', 'e'].map((p) => ({
    path: p + '.md',
    hash: p.repeat(64),
    size: 1,
    baseHash: null,
  }));
  await store.commit(pagedVault, changes, []);

  const page1 = await store.getManifest(pagedVault, { limit: 2 });
  assert.deepEqual(page1.entries.map((e) => e.path), ['a.md', 'b.md']);
  assert.equal(page1.hasMore, true);

  const page2 = await store.getManifest(pagedVault, { after: 'b.md', limit: 2 });
  assert.deepEqual(page2.entries.map((e) => e.path), ['c.md', 'd.md']);
  assert.equal(page2.hasMore, true);

  const page3 = await store.getManifest(pagedVault, { after: 'd.md', limit: 2 });
  assert.deepEqual(page3.entries.map((e) => e.path), ['e.md']);
  assert.equal(page3.hasMore, false);
});

test('commit: stale baseHash conflicts, reports server state, changes nothing', { skip: SKIP }, async () => {
  const casVault = `${vault}-cas`;
  await store.commit(casVault, [
    { path: 'cas.md', hash: '1'.repeat(64), size: 1, baseHash: null },
  ], []);

  const r = await store.commit(casVault, [
    { path: 'cas.md', hash: '2'.repeat(64), size: 1, baseHash: '9'.repeat(64) },
  ], []);
  assert.equal(r.applied.length, 0);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].path, 'cas.md');
  assert.equal(r.conflicts[0].hash, '1'.repeat(64));

  const m = await store.getManifest(casVault, {});
  assert.equal(m.entries[0].hash, '1'.repeat(64));
});

test('commit: matching baseHash applies', { skip: SKIP }, async () => {
  const casVault = `${vault}-cas-ok`;
  await store.commit(casVault, [
    { path: 'ok.md', hash: '3'.repeat(64), size: 1, baseHash: null },
  ], []);
  const r = await store.commit(casVault, [
    { path: 'ok.md', hash: '4'.repeat(64), size: 1, baseHash: '3'.repeat(64) },
  ], []);
  assert.deepEqual(r.applied, ['ok.md']);
  assert.equal(r.conflicts.length, 0);

  const m = await store.getManifest(casVault, {});
  assert.equal(m.entries[0].hash, '4'.repeat(64));
});

test('vaults are isolated', { skip: SKIP }, async () => {
  const other = `${vault}-other`;
  await store.commit(other, [
    { path: 'only-there.md', hash: 'f'.repeat(64), size: 1, baseHash: null },
  ], []);

  const mine = await store.getManifest(vault, {});
  assert.ok(!mine.entries.some((e) => e.path === 'only-there.md'));
  const theirs = await store.getManifest(other, {});
  assert.deepEqual(theirs.entries.map((e) => e.path), ['only-there.md']);
});

test('blob: chunked put round-trips byte-for-byte; missingBlobs reports the rest', { skip: SKIP }, async () => {
  const bytes = Buffer.from(`pg blob round trip ${run}`);
  const hash = sha256Hex(bytes);
  const ghost = sha256Hex(`ghost ${run}`);

  const missingBefore = await store.missingBlobs([hash, ghost]);
  assert.deepEqual(missingBefore.sort(), [hash, ghost].sort());

  await store.putBlobPart(hash, { index: 0, total: 1, size: bytes.length, data: bytes });

  const got = await store.getBlob(hash);
  assert.equal(got.size, bytes.length);
  assert.ok(Buffer.from(got.data).equals(bytes));
  assert.deepEqual(await store.missingBlobs([hash, ghost]), [ghost]);
});

test('blob: content that does not match its hash is rejected EHASH', { skip: SKIP }, async () => {
  const claimed = sha256Hex(Buffer.from(`original ${run}`));
  const tampered = Buffer.from(`tampered ${run}`);
  await assert.rejects(
    store.putBlobPart(claimed, { index: 0, total: 1, size: tampered.length, data: tampered }),
    (err) => err instanceof StoreError && err.code === 'EHASH',
  );
});

test('claims: getClaim misses return null; putClaim is atomic (second insert loses)', { skip: SKIP }, async () => {
  const name = `test-pg-claim-${run}`;
  assert.equal(await store.getClaim(name), null);
  assert.equal(await store.putClaim(name, 'salt-0000', 'hash-0000'), true);
  assert.equal(await store.putClaim(name, 'salt-1111', 'hash-1111'), false);
  assert.deepEqual(await store.getClaim(name), { salt: 'salt-0000', hash: 'hash-0000' });
});
