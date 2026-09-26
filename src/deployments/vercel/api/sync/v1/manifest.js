// GET /sync/v1/manifest — the vault's current file list, paginated.
//
// Same response shape as src/sync-server/manifest.js (so a pull-only client
// works against either backend), plus two fields the serverless backend
// needs because of Vercel's 4.5 MB response cap:
//   hasMore  — true when another page follows (an older server omits it,
//              which is how a client detects "one page, no pagination")
//   cursor   — the vault's revision counter, used as the ETag. It is a
//              revision number here (vs. the fs server's content hash)
//              because there is no directory to walk: it changes exactly
//              when a commit lands.

import { toNodeHandler } from '../../../lib/adapter.js';
import { requireAuth } from '../../../lib/auth.js';
import { MANIFEST_DEFAULT_LIMIT, MANIFEST_MAX_LIMIT } from '../../../lib/config.js';
import { SyncError, getVaultOrThrow, json, withErrors } from '../../../lib/http.js';
import { getStore } from '../../../lib/store.js';
import { isValidPath } from '../../../lib/validate.js';

function parseLimit(raw) {
  if (raw === null) return MANIFEST_DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new SyncError(400, `invalid limit: ${JSON.stringify(raw)}`);
  }
  return Math.min(n, MANIFEST_MAX_LIMIT);
}

export const web = withErrors(async (request) => {
  const denied = requireAuth(request);
  if (denied) return denied;

  const vault = getVaultOrThrow(request);
  const url = new URL(request.url);
  const after = url.searchParams.get('after') || '';
  if (after && !isValidPath(after)) {
    throw new SyncError(400, `invalid after: ${JSON.stringify(after)}`);
  }
  const limit = parseLimit(url.searchParams.get('limit'));

  const store = await getStore();
  const { cursor, entries, hasMore } = await store.getManifest(vault, { after, limit });

  const etag = `"${cursor}"`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  return json({ cursor, entries, hasMore }, 200, {
    etag,
    'cache-control': 'no-store',
  });
});

export default toNodeHandler(web);
