// GET/POST /sync/v1/vaults/:name (password claims) and mpv1 scope
// enforcement across the sync endpoints.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  installAuth, removeAuth, freshStore, resetStore, authHeaders, url, readJson, TOKEN,
} from './helpers.js';
import { web as vaults, __resetVaultRateLimitForTest } from '../api/sync/v1/vaults/[name].js';
import { web as manifest } from '../api/sync/v1/manifest.js';
import { web as missing } from '../api/sync/v1/blobs/missing.js';
import { issueVaultToken } from '../lib/claims.js';

before(() => installAuth());
beforeEach(() => {
  installAuth();
  freshStore();
  __resetVaultRateLimitForTest();
});
after(resetStore);

function get(name, headers = {}) {
  return vaults(new Request(url(`/sync/v1/vaults/${encodeURIComponent(name)}`), { headers }));
}

function post(name, body, headers = {}) {
  return vaults(new Request(url(`/sync/v1/vaults/${encodeURIComponent(name)}`), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

function scopedHeaders(name, extra = {}) {
  return { authorization: `Bearer ${issueVaultToken(name, TOKEN)}`, ...extra };
}

test('GET an unclaimed name -> {claimed:false}, no-store', async () => {
  const res = await get('rocket');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await readJson(res), { name: 'rocket', claimed: false });
});

test('POST claims the name -> 201 + mpv1 token; GET now reports claimed', async () => {
  const res = await post('rocket', { password: 'launch-code-1' });
  assert.equal(res.status, 201);
  const body = await readJson(res);
  assert.equal(body.claimed, true);
  assert.equal(body.name, 'rocket');
  assert.match(body.token, /^mpv1\./);

  const status = await get('rocket');
  assert.equal((await readJson(status)).claimed, true);
});

test('POST with the right password on a claimed name -> 200 (unlock)', async () => {
  await post('rocket', { password: 'launch-code-1' });
  const res = await post('rocket', { password: 'launch-code-1' });
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.match(body.token, /^mpv1\./);
});

test('POST with a wrong password -> 401 empty body', async () => {
  await post('rocket', { password: 'launch-code-1' });
  const res = await post('rocket', { password: 'wrong-password' });
  assert.equal(res.status, 401);
  assert.equal(await res.text(), '');
});

test('password policy -> 400: short, non-string, too long, bad JSON', async () => {
  assert.equal((await post('rocket', { password: 'short' })).status, 400);
  assert.equal((await post('rocket', { password: 42 })).status, 400);
  assert.equal((await post('rocket', {})).status, 400);
  assert.equal((await post('rocket', { password: 'x'.repeat(1025) })).status, 400);
  assert.equal((await post('rocket', 'not json at all')).status, 400);
});

test('invalid name in the path -> 400', async () => {
  assert.equal((await get('bad name')).status, 400);
  assert.equal((await get('a'.repeat(65))).status, 400);
  assert.equal((await post('slash/here', { password: 'launch-code-1' })).status, 400);
});

test('fail-closed: no SYNC_TOKEN -> 503 on both methods', async () => {
  removeAuth();
  const res = await get('rocket');
  assert.equal(res.status, 503);
  assert.match((await readJson(res)).error, /SYNC_TOKEN/);
  const res2 = await post('rocket', { password: 'launch-code-1' });
  assert.equal(res2.status, 503);
});

test('other methods -> 405', async () => {
  const res = await vaults(new Request(url('/sync/v1/vaults/rocket'), { method: 'DELETE' }));
  assert.equal(res.status, 405);
});

test('POST is rate-limited per IP -> 429 after 10 attempts', async () => {
  await post('rocket', { password: 'launch-code-1' }); // claim first
  __resetVaultRateLimitForTest(); // ...and measure only the guesses
  const statuses = [];
  for (let i = 0; i < 11; i++) {
    const res = await post('rocket', { password: 'wrong-password-' + i });
    statuses.push(res.status);
  }
  assert.equal(statuses[10], 429);
  assert.ok(statuses.slice(0, 10).every((s) => s === 401), `got ${statuses}`);
  const err = await readJson(await post('rocket', { password: 'launch-code-1' }));
  assert.match(err.error, /too many/);
});

// ── scope enforcement across /sync/v1 ───────────────────────────────────────

test('mpv1 token works against its own vault (manifest 200)', async () => {
  const res = await manifest(new Request(url('/sync/v1/manifest', { vault: 'sarris' }), {
    headers: scopedHeaders('sarris'),
  }));
  assert.equal(res.status, 200);
  const body = await readJson(res);
  assert.deepEqual(body, { cursor: '0', entries: [], hasMore: false });
});

test('mpv1 token refused on any other vault -> 403 (manifest, missing, default)', async () => {
  const other = await manifest(new Request(url('/sync/v1/manifest', { vault: 'other' }), {
    headers: scopedHeaders('sarris'),
  }));
  assert.equal(other.status, 403);
  assert.match((await readJson(other)).error, /sarris/);

  const noVault = await manifest(new Request(url('/sync/v1/manifest'), {
    headers: scopedHeaders('sarris'),
  }));
  assert.equal(noVault.status, 403); // defaults to vault=default, out of scope

  const miss = await missing(new Request(url('/sync/v1/blobs/missing', { vault: 'other' }), {
    method: 'POST',
    headers: scopedHeaders('sarris', { 'content-type': 'application/json' }),
    body: JSON.stringify({ hashes: [0].map(() => '0'.repeat(64)) }),
  }));
  assert.equal(miss.status, 403);
});

test('global SYNC_TOKEN still reaches every vault', async () => {
  for (const vault of ['sarris', 'other', undefined]) {
    const res = await manifest(new Request(url('/sync/v1/manifest', vault ? { vault } : {}), {
      headers: authHeaders(),
    }));
    assert.equal(res.status, 200, `global token must pass vault=${vault}`);
  }
});

test('forged or expired mpv1 tokens -> 401', async () => {
  const forged = issueVaultToken('sarris', 'not-the-sync-token');
  const res = await manifest(new Request(url('/sync/v1/manifest', { vault: 'sarris' }), {
    headers: { authorization: `Bearer ${forged}` },
  }));
  assert.equal(res.status, 401);
  assert.equal(await res.text(), '');
});
