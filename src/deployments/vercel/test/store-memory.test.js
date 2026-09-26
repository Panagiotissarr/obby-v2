// Contract tests for the memory store — the reference implementation the
// Postgres store must behave identically to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../lib/store-memory.js';
import { sha256Hex, putBlob } from './helpers.js';

function store(limits) {
  return createMemoryStore(limits);
}

test('manifest: empty vault → cursor "0", no entries, hasMore false', async () => {
  const s = store();
  const m = await s.getManifest('default', {});
  assert.deepEqual(m, { cursor: '0', entries: [], hasMore: false });
});

test('manifest: sorted, excludes tombstones, cursor is a string revision', async () => {
  const s = store();
  await s.commit('default', [
    { path: 'b.md', hash: 'b'.repeat(64), size: 2, baseHash: null },
    { path: 'a.md', hash: 'a'.repeat(64), size: 1, baseHash: null },
    { path: 'c.md', hash: 'c'.repeat(64), size: 3, baseHash: null },
  ], []);
  await s.commit('default', [], [{ path: 'c.md', baseHash: 'c'.repeat(64) }]);

  const m = await s.getManifest('default', {});
  assert.deepEqual(m.entries.map((e) => e.path), ['a.md', 'b.md']);
  assert.equal(m.entries[0].hash, 'a'.repeat(64));
  assert.equal(m.entries[0].size, 1);
  assert.equal(m.cursor, '2'); // one bump per applying commit
  assert.equal(m.hasMore, false);
});

test('manifest: pagination with after + limit, exclusive cursor', async () => {
  const s = store();
  const changes = ['a', 'b', 'c', 'd', 'e'].map((p) => ({
    path: p + '.md',
    hash: p.repeat(64),
    size: 1,
    baseHash: null,
  }));
  await s.commit('default', changes, []);

  const page1 = await s.getManifest('default', { limit: 2 });
  assert.deepEqual(page1.entries.map((e) => e.path), ['a.md', 'b.md']);
  assert.equal(page1.hasMore, true);

  const page2 = await s.getManifest('default', { after: 'b.md', limit: 2 });
  assert.deepEqual(page2.entries.map((e) => e.path), ['c.md', 'd.md']);
  assert.equal(page2.hasMore, true);

  const page3 = await s.getManifest('default', { after: 'd.md', limit: 2 });
  assert.deepEqual(page3.entries.map((e) => e.path), ['e.md']);
  assert.equal(page3.hasMore, false);
});

test('manifest: vaults are isolated', async () => {
  const s = store();
  await s.commit('alpha', [{ path: 'x.md', hash: 'a'.repeat(64), size: 1, baseHash: null }], []);
  const beta = await s.getManifest('beta', {});
  assert.deepEqual(beta.entries, []);
});

test('blob: single chunk assembles, verifies hash, stores', async () => {
  const s = store();
  const data = Buffer.from('hello vault');
  const hash = sha256Hex(data);

  const first = await s.putBlobPart(hash, { index: 0, total: 1, size: data.length, data });
  assert.deepEqual(first, { stored: true });

  const blob = await s.getBlob(hash);
  assert.ok(blob.data.equals(data));
  assert.equal(blob.size, data.length);
});

test('blob: multi-chunk upload stores only when every chunk has arrived', async () => {
  const s = store();
  const data = Buffer.from('0123456789abcdef');
  const hash = sha256Hex(data);
  const half = data.length / 2;

  const c0 = await s.putBlobPart(hash, { index: 0, total: 2, size: data.length, data: data.subarray(0, half) });
  assert.deepEqual(c0, { stored: false });
  assert.equal(await s.getBlob(hash), null);

  const c1 = await s.putBlobPart(hash, { index: 1, total: 2, size: data.length, data: data.subarray(half) });
  assert.deepEqual(c1, { stored: true });
  assert.ok((await s.getBlob(hash)).data.equals(data));
});

test('blob: wrong content → EHASH, wrong size → ESIZE, parts discarded', async () => {
  const s = store();
  const data = Buffer.from('payload');
  const wrongHash = 'f'.repeat(64);

  await assert.rejects(
    () => s.putBlobPart(wrongHash, { index: 0, total: 1, size: data.length, data }),
    (err) => err.name === 'StoreError' && err.code === 'EHASH'
  );
  assert.equal(await s.getBlob(wrongHash), null);

  const realHash = sha256Hex(data);
  await assert.rejects(
    () => s.putBlobPart(realHash, { index: 0, total: 1, size: data.length + 1, data }),
    (err) => err.name === 'StoreError' && err.code === 'ESIZE'
  );
  assert.equal(await s.getBlob(realHash), null);
});

test('blob: re-uploading an existing blob is an idempotent no-op', async () => {
  const s = store();
  const hash = await putBlob(s, 'already here');
  const again = await s.putBlobPart(hash, { index: 0, total: 1, size: 12, data: Buffer.from('already here') });
  assert.deepEqual(again, { stored: true });
});

test('blob: size limits are refused before any assembly', async () => {
  const s = store({ maxBlobBytes: 10, maxPartBytes: 4 });
  const hash = sha256Hex(Buffer.from('0123456789A'));

  await assert.rejects(
    () => s.putBlobPart(hash, { index: 0, total: 1, size: 11, data: Buffer.alloc(0) }),
    (err) => err.code === 'ETOOLARGE'
  );
  await assert.rejects(
    () => s.putBlobPart(hash, { index: 0, total: 1, size: 5, data: Buffer.alloc(5) }),
    (err) => err.code === 'ETOOLARGE'
  );
});

test('missingBlobs: only reports what is absent', async () => {
  const s = store();
  const present = await putBlob(s, 'kept');
  const absent = 'd'.repeat(64);
  assert.deepEqual(await s.missingBlobs([present, absent]), [absent]);
  assert.deepEqual(await s.missingBlobs([]), []);
});

test('commit: applies, reports rev, and is CAS-safe on a stale base', async () => {
  const s = store();
  const h1 = '1'.repeat(64);
  const h2 = '2'.repeat(64);

  const r1 = await s.commit('default', [{ path: 'n.md', hash: h1, size: 1, baseHash: null }], []);
  assert.deepEqual(r1.applied, ['n.md']);
  assert.equal(r1.rev, '1');

  // stale base (null) but identical content — applies per the rules
  const r2 = await s.commit('default', [{ path: 'n.md', hash: h1, size: 1, baseHash: null }], []);
  assert.deepEqual(r2.applied, ['n.md']);

  // stale base, different content — conflict, server untouched
  const r3 = await s.commit('default', [{ path: 'n.md', hash: h2, size: 9, baseHash: 'e'.repeat(64) }], []);
  assert.deepEqual(r3.applied, []);
  assert.equal(r3.conflicts[0].hash, h1);
  const m = await s.getManifest('default', {});
  assert.equal(m.entries[0].hash, h1);
});

test('commit: nothing applied → rev does not move', async () => {
  const s = store();
  const r1 = await s.commit('default', [{ path: 'n.md', hash: '1'.repeat(64), size: 1, baseHash: null }], []);
  assert.equal(r1.rev, '1');
  const r2 = await s.commit('default', [], [{ path: 'n.md', baseHash: '2'.repeat(64) }]);
  assert.deepEqual(r2.applied, []);
  assert.equal(r2.rev, '1');
});

test('commit: deletions remove entries from the manifest', async () => {
  const s = store();
  const h = 'a'.repeat(64);
  await s.commit('default', [{ path: 'gone.md', hash: h, size: 1, baseHash: null }], []);
  const del = await s.commit('default', [], [{ path: 'gone.md', baseHash: h }]);
  assert.deepEqual(del.applied, ['gone.md']);
  const m = await s.getManifest('default', {});
  assert.deepEqual(m.entries, []);
});
