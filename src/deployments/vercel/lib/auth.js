// Bearer-token auth for /sync/v1 — same contract as src/sync-server/auth.js:
// `Authorization: Bearer <SYNC_TOKEN>`, sha256 both sides, constant-time
// compare (a wrong token costs O(1) and leaks neither length nor content).
//
// Fail-closed: without SYNC_TOKEN every sync request is refused (503) rather
// than served. Serverless has no "refuse to boot" moment, so the refusal
// happens per-request instead of at listen() — same guarantee, different
// timing.

import { createHash, timingSafeEqual } from 'node:crypto';
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
export function requireAuth(request) {
  const expected = getSyncToken();
  if (!expected) {
    return json({ error: 'sync not configured: set SYNC_TOKEN' }, 503);
  }
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!checkToken(token, expected)) {
    return new Response(null, { status: 401 }); // empty body, like sync-server
  }
  return null;
}
