// Shared fixtures for the /sync/v1 test suite. Each test file runs in its
// own process (node --test spawns one per file), so process.env mutations
// here never leak between files.

import { createHash } from 'node:crypto';
import { __setStoreForTest, __resetStoreForTest } from '../lib/store.js';
import { createMemoryStore } from '../lib/store-memory.js';

export const TOKEN = 'test-secret-token';

export function installAuth(token = TOKEN) {
  process.env.SYNC_TOKEN = token;
}

export function removeAuth() {
  delete process.env.SYNC_TOKEN;
}

// Replace the process-wide store with a fresh, empty memory store.
export function freshStore(limits) {
  const store = createMemoryStore(limits);
  __setStoreForTest(store);
  return store;
}

export function resetStore() {
  __resetStoreForTest();
}

export function authHeaders(extra = {}) {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

export function url(path, query) {
  const search = query
    ? '?' + new URLSearchParams(query).toString()
    : '';
  return 'http://localhost' + path + search;
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

// Upload a blob to a store the way the chunked endpoint does (from a test,
// bypassing HTTP), returning its hash.
export async function putBlob(store, bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const hash = sha256Hex(buf);
  await store.putBlobPart(hash, {
    index: 0,
    total: 1,
    size: buf.length,
    data: buf,
  });
  return hash;
}

export async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}
