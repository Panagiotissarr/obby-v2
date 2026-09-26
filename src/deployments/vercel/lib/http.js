// Shared HTTP helpers for the /sync/v1 Vercel functions.
//
// Handlers are written as plain web-standard `(Request) => Response`
// functions (see lib/adapter.js for the Node/Vercel bridge), so everything
// here is platform-neutral and unit-testable with `new Request(...)`.

import { SyncError } from './errors.js';

export { SyncError } from './errors.js';

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function empty(status = 204) {
  return new Response(null, { status });
}

// The vault a request targets: `?vault=<id>` (per-vault sync config in the
// client's localStorage), defaulting to `default`. One deployment can hold
// several vaults; a single SYNC_TOKEN grants access to all of them (this is
// a personal deployment, not multi-tenant hosting — see README).
const VAULT_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function getVault(request) {
  const url = new URL(request.url);
  const vault = url.searchParams.get('vault');
  if (vault === null || vault === '') return 'default';
  return vault;
}

export function getVaultOrThrow(request) {
  const vault = getVault(request);
  if (!VAULT_RE.test(vault)) {
    throw new SyncError(400, `invalid vault id: ${JSON.stringify(vault)}`);
  }
  return vault;
}

// Wrap a web handler so a SyncError becomes its intended status code, a
// StoreError becomes the status its code implies, and anything else becomes
// an opaque 500 (no stack traces / internals leaked — same contract as
// src/sync-server/index.js's error handler).
const STORE_ERROR_STATUS = {
  EHASH: [409, 'content does not match the requested hash'],
  ESIZE: [400, 'content size does not match the declared size'],
  ETOOLARGE: [413, 'content is larger than this server accepts'],
};

export function withErrors(handler) {
  return async (request) => {
    try {
      return await handler(request);
    } catch (err) {
      if (err instanceof SyncError) {
        return json({ error: err.message, ...(err.hashes ? { hashes: err.hashes } : {}) }, err.status);
      }
      if (err && err.name === 'StoreError' && STORE_ERROR_STATUS[err.code]) {
        const [status, message] = STORE_ERROR_STATUS[err.code];
        return json({ error: message }, status);
      }
      console.error('[vercel:sync] internal error on', request.method, request.url, '-', err);
      return json({ error: 'internal error' }, 500);
    }
  };
}
