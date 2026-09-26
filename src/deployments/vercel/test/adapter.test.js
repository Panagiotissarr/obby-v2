// The Vercel bridge: (req, res) ⇄ (Request) => Response. Covers both body
// paths (Vercel-parsed req.body, and a raw stream for the local dev server)
// plus a full round trip over a real http.Server.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { nodeToRequest, toNodeHandler } from '../lib/adapter.js';
import { web as manifest } from '../api/sync/v1/manifest.js';
import { web as blobsMissing } from '../api/sync/v1/blobs/missing.js';
import { installAuth, freshStore, resetStore, authHeaders, TOKEN, putBlob } from './helpers.js';

before(() => installAuth());
beforeEach(() => freshStore());
after(resetStore);

function mockReq({ headers = {}, url = '/', method = 'GET', body, raw } = {}) {
  const req = { headers: { host: 'localhost', ...headers }, url, method };
  if (body !== undefined) req.body = body;
  if (raw) {
    req[Symbol.asyncIterator] = function* () {
      for (const chunk of raw) yield Buffer.from(chunk);
    };
  }
  return req;
}

test('nodeToRequest: Vercel-parsed object body is re-serialized with its content-type', async () => {
  const req = mockReq({
    method: 'POST',
    url: '/sync/v1/blobs/missing',
    headers: { 'content-type': 'application/json' },
    body: { hashes: ['aa'] },
  });
  const request = await nodeToRequest(req);
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.get('content-type'), 'application/json');
  assert.deepEqual(await request.json(), { hashes: ['aa'] });
});

test('nodeToRequest: a raw stream body is read whole (local dev path)', async () => {
  const payload = JSON.stringify({ hashes: [] });
  const req = mockReq({
    method: 'POST',
    url: '/sync/v1/blobs/missing',
    headers: { 'content-type': 'application/json' },
    raw: [payload.slice(0, 5), payload.slice(5)],
  });
  const request = await nodeToRequest(req);
  assert.deepEqual(await request.json(), { hashes: [] });
});

test('nodeToRequest: GET/HEAD never wait for a body', async () => {
  const request = await nodeToRequest(mockReq({ method: 'GET', url: '/x' }));
  assert.equal(request.body, null);
  assert.equal(new URL(request.url).pathname, '/x');
});

test('round trip through a real http.Server: JSON in, JSON + status out', async () => {
  const store = freshStore();
  const presentHash = await putBlob(store, 'present');

  const server = http.createServer(async (req, res) => {
    await toNodeHandler(blobsMissing)(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${base}/sync/v1/blobs/missing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ hashes: [presentHash, 'b'.repeat(64)] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { missing: ['b'.repeat(64)] });

    const denied = await fetch(`${base}/sync/v1/blobs/missing`, { method: 'POST', body: '{}' });
    assert.equal(denied.status, 401);
    assert.equal(await denied.text(), '');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('round trip: GET manifest keeps its ETag header', async () => {
  const server = http.createServer(async (req, res) => {
    await toNodeHandler(manifest)(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/sync/v1/manifest`, {
      headers: authHeaders(),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('etag'), '"0"');
    assert.deepEqual(await res.json(), { cursor: '0', entries: [], hasMore: false });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
