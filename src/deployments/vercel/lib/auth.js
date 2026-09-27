// Bearer-token auth for /sync/v1 — same contract as src/sync-server/auth.js:
// `Authorization: Bearer <SYNC_TOKEN>`, sha256 both sides, constant-time
// compare (a wrong token costs O(1) and leaks neither length nor content).
//
// Fail-closed: without SYNC_TOKEN every sync request is refused (503) rather
// than served. Serverless has no "refuse to boot" moment, so the refusal
// happens per-request instead of at listen() — same guarantee, different
// timing.

import { createHash, timingSafeEqual } from 'node:crypto';
import { verifyVaultToken } from './claims.js';
import { getSyncToken } from './config.js';
import { json } from './http.js';

function digest(value) {
  return createHash('sha256').update(value).digest();
}

export function checkToken(provided, expected) {
  if (!expected) return false;
  const providedDigest = digest(provided || '');
  const expectedDigest = digest(expected);
  if (!provided) return false;
  return timingSafeEqual(providedDigest, expectedDigest);
}

// Returns `null` when the request is authorized, otherwise the 401/503
// Response to send back — so handlers read:
//   const denied = await requireAuth(request); if (denied) return denied;
//
// Two token shapes are accepted (see lib/claims.js for the second):
//   - the global SYNC_TOKEN: full access to every vault (the operator key);
//   - `mpv1.<name>.<exp>.<sig>`: scoped to one vault. On success the scope
//     is attached as `request.vaultScope`, and getVaultOrThrow (lib/http.js)
//     refuses any other `?vault=` with 403.
export function requireAuth(request) {
  const expected = getSyncToken();
  if (!expected) {
    return json({ error: 'sync not configured: set SYNC_TOKEN' }, 503);
  }
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    return new Response(null, { status: 401 }); // empty body, like sync-server
  }
  if (token.startsWith('mpv1.')) {
    const scope = verifyVaultToken(token, expected);
    if (!scope) {
      return new Response(null, { status: 401 });
    }
    request.vaultScope = scope;
    return null;
  }
  if (!checkToken(token, expected)) {
    return new Response(null, { status: 401 });
  }
  return null;
}
