// POST /sync/v1/blobs/missing — "which of these hashes do you NOT have?".
//
// Lets a client skip re-uploading content that already exists on the server
// (renames, edits that reverted to known content, a second device joining a
// populated vault) without paying for the bytes first. Pure optimization:
// a wrong answer only costs a redundant upload, because PUT /blob/:hash is
// idempotent and commit() independently verifies presence.

import { toNodeHandler } from '../../../../lib/adapter.js';
import { requireAuth } from '../../../../lib/auth.js';
import { MAX_HASH_BATCH } from '../../../../lib/config.js';
import { SyncError, getVaultOrThrow, json, withErrors } from '../../../../lib/http.js';
import { getStore } from '../../../../lib/store.js';
import { isValidHash } from '../../../../lib/validate.js';

export const web = withErrors(async (request) => {
  if (request.method !== 'POST') throw new SyncError(405, 'method not allowed');
  const denied = requireAuth(request);
  if (denied) return denied;
  getVaultOrThrow(request); // enforce mpv1 token scope

  let body;
  try {
    body = await request.json();
  } catch (_) {
    throw new SyncError(400, 'body must be a JSON object');
  }
  const hashes = body && body.hashes;
  if (!Array.isArray(hashes)) {
    throw new SyncError(400, 'hashes must be an array');
  }
  if (hashes.length > MAX_HASH_BATCH) {
    throw new SyncError(413, `too many hashes (max ${MAX_HASH_BATCH})`);
  }
  const unique = [...new Set(hashes)];
  for (const hash of unique) {
    if (!isValidHash(hash)) {
      throw new SyncError(400, `invalid hash: ${JSON.stringify(hash)}`);
    }
  }

  const store = await getStore();
  const missing = await store.missingBlobs(unique);
  return json({ missing });
});

export default toNodeHandler(web);
