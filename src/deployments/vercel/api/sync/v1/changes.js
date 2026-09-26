// GET /sync/v1/changes — cursor-delta manifest. Not implemented: the client
// fetches the full (paginated) manifest instead, which is cheap because the
// whole listing lives in Postgres rather than behind a filesystem walk.
// Routed stub so a client gets a self-describing 501 instead of a 404
// (same contract as src/sync-server/stubs-v2.js).

import { toNodeHandler } from '../../../lib/adapter.js';
import { json, withErrors } from '../../../lib/http.js';

export const web = withErrors(async (request) =>
  json({ error: 'not implemented', path: new URL(request.url).pathname }, 501)
);

export default toNodeHandler(web);