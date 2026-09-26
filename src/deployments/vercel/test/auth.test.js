// Auth contract: fail-closed (no SYNC_TOKEN → 503), constant-shape 401s
// (empty body, like src/sync-server/auth.js), Bearer scheme only.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { installAuth, removeAuth, freshStore, resetStore, TOKEN, url } from './helpers.js';
import { web as manifest } from '../api/sync/v1/manifest.js';

before(() => {
  installAuth();
});
beforeEach(() => {
  installAuth();
  freshStore();
});
after(resetStore);

test('no SYNC_TOKEN configured → 503, sync stays off', async () => {
  removeAuth();
  const res = await manifest(new Request(url('/sync/v1/manifest'), { headers: { authorization: `Bearer ${TOKEN}` } }));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /SYNC_TOKEN/);
});

test('missing Authorization header → 401 with an empty body', async () => {
  const res = await manifest(new Request(url('/sync/v1/manifest')));
  assert.equal(res.status, 401);
  assert.equal(await res.text(), '');
});

test('wrong token → 401 empty body', async () => {
  const res = await manifest(new Request(url('/sync/v1/manifest'), {
    headers: { authorization: 'Bearer wrong' },
  }));
  assert.equal(res.status, 401);
  assert.equal(await res.text(), '');
});

test('non-Bearer scheme → 401 (token in query/cookie is not accepted)', async () => {
  const res = await manifest(new Request(url('/sync/v1/manifest'), {
    headers: { authorization: TOKEN },
  }));
  assert.equal(res.status, 401);
});

test('correct token → request reaches the handler', async () => {
  const res = await manifest(new Request(url('/sync/v1/manifest'), {
    headers: { authorization: `Bearer ${TOKEN}` },
  }));
  assert.equal(res.status, 200);
});
