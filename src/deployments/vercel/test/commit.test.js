// POST /sync/v1/commit — bidirectional push: apply, conflict, validate.
// Also covers POST /sync/v1/blobs/missing.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  installAuth, freshStore, resetStore, authHeaders, url, readJson, putBlob, sha256Hex,
} from './helpers.js';
import { web as commit } from '../api/sync/v1/commit.js';
import { web as missing } from '../api/sync/v1/blobs/missing.js';
import { MAX_COMMIT_OPS, MAX_HASH_BATCH } from '../lib/config.js';

before(() => installAuth());
beforeEach(() => freshStore());
after(resetStore);

function post(handler, path, body, query) {
  return handler(new Request(url(path, query), {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  }));
}

const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);

test('first push applies, bumps the rev, and shows up in the manifest', async () => {
  const store = freshStore();
  await putBlob(store, 'hello');

  const res = await post(commit, '/sync/v1/commit', {
    changes: [{ path: 'notes/hello.md', hash: sha256Hex('hello'), size: 5, baseHash: null }],
  });
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.deepEqual(body.applied, ['notes/hello.md']);
  assert.deepEqual(body.conflicts, []);
  assert.equal(body.rev, '1');

  const manifest = await store.getManifest('default', {});
  assert.equal(manifest.entries[0].path, 'notes/hello.md');
});

test('stale base with different content → conflict reports the server state, nothing overwritten', async () => {
  const store = freshStore();
  const theirs = await putBlob(store, 'theirs');
  await post(commit, '/sync/v1/commit', {
    changes: [{ path: 'note.md', hash: theirs, size: 6, baseHash: null }],
  });

  const ours = await putBlob(store, 'ours');
  const res = await post(commit, '/sync/v1/commit', {
    changes: [{ path: 'note.md', hash: ours, size: 4, baseHash: H1 }],
  });
  const body = await readJson(res);
  assert.deepEqual(body.applied, []);
  assert.deepEqual(body.conflicts, [{
    path: 'note.md',
    hash: theirs,
    size: 6,
    deleted: false,
  }]);

  const manifest = await store.getManifest('default', {});
  assert.equal(manifest.entries[0].hash, theirs); // server untouched
});

test('deleting applies and removes the path; deleting again is idempotent', async () => {
  const store = freshStore();
  await putBlob(store, 'gone soon');
  const h = sha256Hex('gone soon');
  await post(commit, '/sync/v1/commit', { changes: [{ path: 'x.md', hash: h, size: 9, baseHash: null }] });

  const del = await post(commit, '/sync/v1/commit', { deletions: [{ path: 'x.md', baseHash: h }] });
  assert.deepEqual((await readJson(del)).applied, ['x.md']);

  const again = await post(commit, '/sync/v1/commit', { deletions: [{ path: 'x.md', baseHash: h }] });
  assert.deepEqual((await readJson(again)).applied, ['x.md']);

  const manifest = await store.getManifest('default', {});
  assert.deepEqual(manifest.entries, []);
});

test('deletion of a path the server never had → applied (idempotent no-op)', async () => {
  const res = await post(commit, '/sync/v1/commit', { deletions: [{ path: 'never.md', baseHash: H1 }] });
  assert.equal(res.status, 200);
  assert.deepEqual((await readJson(res)).applied, ['never.md']);
});

test('change whose content is not on the server → 422 with the missing hashes', async () => {
  const res = await post(commit, '/sync/v1/commit', {
    changes: [{ path: 'note.md', hash: H1, size: 1, baseHash: null }],
  });
  assert.equal(res.status, 422);
  const body = await readJson(res);
  assert.equal(body.error, 'missing blobs');
  assert.deepEqual(body.hashes, [H1]);
});

test('mixed batch: applied and conflicted paths are reported separately', async () => {
  const store = freshStore();
  const theirs = await putBlob(store, 'theirs content');
  const ours = await putBlob(store, 'our new content');

  await post(commit, '/sync/v1/commit', {
    changes: [
      { path: 'stable.md', hash: await putBlob(store, 'stable v1'), size: 7, baseHash: null },
      { path: 'racy.md', hash: theirs, size: 13, baseHash: null },
    ],
  });

  const res = await post(commit, '/sync/v1/commit', {
    changes: [
      { path: 'stable.md', hash: ours, size: 15, baseHash: await putBlob(store, 'stable v1') },
      { path: 'racy.md', hash: ours, size: 15, baseHash: H1 },
    ],
    deletions: [{ path: 'already-gone.md', baseHash: H2 }],
  });
  const body = await readJson(res);
  assert.deepEqual(body.applied.sort(), ['already-gone.md', 'stable.md']);
  assert.deepEqual(body.conflicts.map((c) => c.path), ['racy.md']);
});

test('input validation → 400', async () => {
  const hash = 'a'.repeat(64);
  const cases = [
    { changes: [{ path: '../escape.md', hash, size: 1, baseHash: null }] },
    { changes: [{ path: '/abs.md', hash, size: 1, baseHash: null }] },
    { changes: [{ path: 'ok.md', hash: 'nope', size: 1, baseHash: null }] },
    { changes: [{ path: 'ok.md', hash, size: -1, baseHash: null }] },
    { changes: [{ path: 'ok.md', hash, size: 1, baseHash: 'not-a-hash' }] },
    { changes: [{ path: 'same.md', hash, size: 1, baseHash: null }],
      deletions: [{ path: 'same.md', baseHash: null }] },
    { changes: 'not an array' },
    { deletions: [{ path: 'a/b\\c.md', baseHash: null }] },
  ];
  for (const body of cases) {
    const res = await post(commit, '/sync/v1/commit', body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

test('too many operations in one commit → 413', async () => {
  const changes = [];
  for (let i = 0; i < MAX_COMMIT_OPS + 1; i++) {
    changes.push({ path: `f${i}.md`, hash: H1, size: 1, baseHash: null });
  }
  const res = await post(commit, '/sync/v1/commit', { changes });
  assert.equal(res.status, 413);
});

test('size above SYNC_MAX_BLOB_BYTES → 400', async () => {
  const max = 64 * 1024 * 1024;
  const res = await post(commit, '/sync/v1/commit', {
    changes: [{ path: 'huge.md', hash: H1, size: max + 1, baseHash: null }],
  });
  assert.equal(res.status, 400);
});

test('empty commit → 200 with the current cursor', async () => {
  const res = await post(commit, '/sync/v1/commit', {});
  assert.equal(res.status, 200);
  assert.deepEqual(await readJson(res), { rev: '0', applied: [], conflicts: [] });
});

test('non-POST / invalid JSON / missing auth → 405 / 400 / 401', async () => {
  assert.equal((await commit(new Request(url('/sync/v1/commit'), { headers: authHeaders() }))).status, 405);

  const badJson = await commit(new Request(url('/sync/v1/commit'), {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: '{oops',
  }));
  assert.equal(badJson.status, 400);

  const anon = await commit(new Request(url('/sync/v1/commit'), { method: 'POST', body: '{}' }));
  assert.equal(anon.status, 401);
});

test('commit scoped by ?vault= lands in that vault only', async () => {
  const store = freshStore();
  await putBlob(store, 'for beta');
  await post(commit, '/sync/v1/commit', {
    changes: [{ path: 'v.md', hash: sha256Hex('for beta'), size: 8, baseHash: null }],
  }, { vault: 'beta' });

  assert.equal((await store.getManifest('beta', {})).entries.length, 1);
  assert.equal((await store.getManifest('default', {})).entries.length, 0);
});

test('blobs/missing → {missing:[...]}; validation → 400/413', async () => {
  const store = freshStore();
  const present = await putBlob(store, 'here');
  const absent = 'b'.repeat(64);

  const res = await post(missing, '/sync/v1/blobs/missing', { hashes: [present, absent, present] });
  assert.equal(res.status, 200);
  assert.deepEqual(await readJson(res), { missing: [absent] });

  assert.equal((await post(missing, '/sync/v1/blobs/missing', {})).status, 400);
  assert.equal((await post(missing, '/sync/v1/blobs/missing', { hashes: ['nope'] })).status, 400);
  assert.equal((await post(missing, '/sync/v1/blobs/missing', { hashes: new Array(MAX_HASH_BATCH + 1).fill(present) })).status, 413);
  assert.equal((await missing(new Request(url('/sync/v1/blobs/missing'), { method: 'GET', headers: authHeaders() }))).status, 405);
});
