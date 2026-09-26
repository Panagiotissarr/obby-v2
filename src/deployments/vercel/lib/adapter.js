// Bridge between Vercel's Node.js function signature `(req, res)` and the
// web-standard `(Request) => Response` shape the sync handlers are written
// in.
//
// Why: every handler is testable with nothing but `new Request(...)`, and
// none of the sync logic knows it is running on Vercel. The adapter is the
// only place that touches Node's http objects.
//
// Body handling: Vercel's Node runtime parses JSON request bodies before the
// handler runs (`req.body`), which consumes the stream — so we prefer
// `req.body` when present and fall back to reading the raw stream (used by
// the local dev server and by tests that build their own http.Server).

const MAX_BODY_BYTES = 8 * 1024 * 1024; // above any single sync request we allow

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('request body too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function nodeToRequest(req) {
  const host = req.headers.host || 'localhost';
  const url = 'http://' + host + (req.url || '/');
  const method = (req.method || 'GET').toUpperCase();

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
  }

  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    if (req.body !== undefined && req.body !== null) {
      // Vercel already parsed it. Objects came from application/json, so
      // re-serializing round-trips faithfully and the original
      // content-type header still says json.
      if (Buffer.isBuffer(req.body)) body = req.body;
      else if (typeof req.body === 'string') body = req.body;
      else body = JSON.stringify(req.body);
    } else {
      const raw = await readRawBody(req);
      body = raw.length ? raw : undefined;
    }
  }

  return new Request(url, { method, headers, body });
}

export async function sendResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    // Node's ServerResponse rejects hop-by-hop headers; skip those only.
    if (key === 'connection' || key === 'transfer-encoding') return;
    try {
      res.setHeader(key, value);
    } catch (_) {
      /* header already sent / invalid — ignore */
    }
  });
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
}

export function toNodeHandler(webHandler) {
  return async function nodeHandler(req, res) {
    let response;
    try {
      const request = await nodeToRequest(req);
      response = await webHandler(request);
    } catch (err) {
      console.error('[vercel:fn] unhandled', err);
      response = new Response(JSON.stringify({ error: 'internal error' }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    try {
      await sendResponse(res, response);
    } catch (err) {
      console.error('[vercel:fn] failed to send response', err);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
  };
}
