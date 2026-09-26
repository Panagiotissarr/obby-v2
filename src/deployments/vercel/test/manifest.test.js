// GET /sync/v1/manifest — pagination, ETag, validation, vault isolation.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  installAuth, freshStore, resetStore, authHeaders, url, readJson,
} from './helpers.js';
import { web as manifest } from '../api/sync/v1/manifest.js';

before(() => installAuth());
beforeEach(() => freshStore());
after(resetStore);

async function get(query) {
  return manifest(new Request(url('/sync/v1/manifest', query), { headers: authHeaders() }));
}

function seed(store, paths) {
  return store.commit('default', paths.map((p, i) => ({
    path: p,
    hash: String(i).padStart(64, '0'),
    size: i,
    baseHash: null,
  })), []);
}

test('empty vault → cursor "0", hasMore false, ETag header', async () => {
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('etag'), '"0"');
  assert.deepEqual(await readJson(res), { cursor: '0', entries: [], hasMore: false });
});

test('If-None-Match with the current cursor → 304', async () => {
  const res = await manifest(new Request(url('/sync/v1/manifest'), {
    headers: authHeaders({ 'if-none-match': '"0"' }),
  }));
  assert.equal(res.status, 304);
  assert.equal(await res.text(), '');
});

test('after a commit the ETag changes (clients refetch)', async () => {
  const store = freshStore();
  await seed(store, ['a.md']);
  const res = await get();
  assert.equal(res.headers.get('etag'), '"1"');
  const body = await readJson(res);
  assert.equal(body.cursor, '1');
  assert.equal(body.entries.length, 1);
});

test('pagination: limit + after, hasMore tracks the tail', async () => {
  const store = freshStore();
  await seed(store, ['a.md', 'b.md', 'c.md']);

  const p1 = await get({ limit: 2 });
  const b1 = await readJson(p1);
  assert.deepEqual(b1.entries.map((e) => e.path), ['a.md', 'b.md']);
  assert.equal(b1.hasMore, true);

  const p2 = await get({ limit: 2, after: 'b.md' });
  const b2 = await readJson(p2);
  assert.deepEqual(b2.entries.map((e) => e.path), ['c.md']);
  assert.equal(b2.hasMore, false);
});

test('limit validation: 0 / non-numeric → 400; huge → clamped, not rejected', async () => {
  assert.equal((await get({ limit: '0' })).status, 400);
  assert.equal((await get({ limit: 'abc' })).status, 400);
  assert.equal((await get({ limit: '99999' })).status, 200);
});

test('after validation: traversal / backslash / control chars → 400', async () => {
  assert.equal((await get({ after: '../x' })).status, 400);
  assert.equal((await get({ after: 'a\\b.md' })).status, 400);
  assert.equal((await get({ after: '/abs.md' })).status, 400);
});

test('vault validation: odd ids → 400; unknown-but-valid ids → empty manifest', async () => {
  assert.equal((await get({ vault: 'has space' })).status, 400);
  assert.equal((await get({ vault: 'a/b' })).status, 400);

  const res = await get({ vault: 'second-vault' });
  assert.equal(res.status, 200);
  assert.deepEqual((await readJson(res)).entries, []);
});

test('vaults are isolated: entries never bleed between vault ids', async () => {
  const store = freshStore();
  await store.commit('alpha', [{ path: 'only-in-alpha.md', hash: 'a'.repeat(64), size: 1, baseHash: null }], []);

  const alpha = await readJson(await get({ vault: 'alpha' }));
  assert.deepEqual(alpha.entries.map((e) => e.path), ['only-in-alpha.md']);

  const beta = await readJson(await get({ vault: 'beta' }));
  assert.deepEqual(beta.entries, []);
  assert.notEqual(alpha.cursor, beta.cursor);
});
