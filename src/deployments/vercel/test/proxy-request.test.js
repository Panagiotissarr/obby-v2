// POST /api/proxy-request — allow-list, SSRF guard, redirects, rate limit.
// Outbound fetch is stubbed: these tests never touch the network.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  web as proxy, isAllowed, __resetRateLimit,
} from '../api/proxy-request.js';

const realFetch = globalThis.fetch;
let fetchCalls = [];
let fetchQueue = [];

function installFetch(impl) {
  globalThis.fetch = async (input, init) => {
    // Snapshot headers: the redirect loop mutates its header object between
    // calls, and these tests assert what each individual call carried.
    const safeInit = init
      ? { ...init, headers: init.headers ? { ...init.headers } : init.headers }
      : init;
    fetchCalls.push({ url: String(input), init: safeInit });
    if (impl) return impl(String(input), init);
    const next = fetchQueue.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
  };
}

before(() => {
  installFetch(null);
});
beforeEach(() => {
  installFetch(null); // drop any stub a previous test installed
  fetchCalls = [];
  fetchQueue = [];
  __resetRateLimit();
});
after(() => {
  globalThis.fetch = realFetch;
});

function post(body, { ip = '9.9.9.9', headers = {} } = {}) {
  return proxy(new Request('http://localhost/api/proxy-request', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ip ? { 'x-forwarded-for': ip } : {}),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

test('isAllowed: release/GitHub/obsidian hosts and their subdomains pass', () => {
  assert.equal(isAllowed('https://releases.obsidian.md/win/Obsidian.exe'), true);
  assert.equal(isAllowed('https://raw.githubusercontent.com/u/r/main/file.js'), true);
  assert.equal(isAllowed('https://codeload.github.com/u/r/zip/main'), true);
  assert.equal(isAllowed('https://forum.obsidian.md/x'), true);
  assert.equal(isAllowed('https://templater-unsplash-2.fly.dev/img.jpg'), true);
  assert.equal(isAllowed('https://evil.example.com/'), false);
  assert.equal(isAllowed('https://obsidian.md.evil.com/'), false);
  assert.equal(isAllowed('not a url'), false);
});

test('allowed URL → 200 with {status, lowercase headers, base64 body}', async () => {
  installFetch(() => new Response('plugin-bytes', {
    status: 200,
    headers: { 'Content-Type': 'text/javascript', 'X-Custom': 'V' },
  }));

  const res = await post({ url: 'https://raw.githubusercontent.com/u/r/main/main.js' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 200);
  assert.equal(body.headers['content-type'], 'text/javascript');
  assert.equal(body.headers['x-custom'], 'V');
  assert.equal(Buffer.from(body.body, 'base64').toString(), 'plugin-bytes');
});

test('disallowed host → 403 and fetch is never called', async () => {
  const res = await post({ url: 'https://169.254.169.254/latest/meta-data/' });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /host not allowed/);
  assert.equal(fetchCalls.length, 0);
});

test('bad bodies → 400', async () => {
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ url: 42 })).status, 400);
  assert.equal(fetchCalls.length, 0);
});

test('network failure → 502 (never an unhandled crash)', async () => {
  fetchQueue.push(new Error('ECONNREFUSED'));
  const res = await post({ url: 'https://releases.obsidian.md/x' });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /ECONNREFUSED/);
});

test('redirect to a disallowed host is refused', async () => {
  fetchQueue.push(new Response('', {
    status: 302,
    headers: { location: 'http://169.254.169.254/latest/meta-data/' },
  }));
  const res = await post({ url: 'https://github.com/u/r/releases' });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /redirect/);
  assert.equal(fetchCalls.length, 1); // stopped at the guard
});

test('cross-host redirect follows but drops auth/cookies', async () => {
  fetchQueue.push(new Response('', {
    status: 302,
    headers: { location: 'https://objects.githubusercontent.com/object' },
  }));
  fetchQueue.push(new Response('moved', { status: 200 }));

  const res = await post({
    url: 'https://github.com/u/r/releases/latest',
    headers: { authorization: 'Bearer secret', cookie: 'session=1' },
  });
  assert.equal(res.status, 200);
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].init.headers.authorization, 'Bearer secret');
  assert.equal(fetchCalls[1].init.headers.authorization, undefined);
  assert.equal(fetchCalls[1].init.headers.cookie, undefined);
  assert.equal(fetchCalls[1].url, 'https://objects.githubusercontent.com/object');
});

test('binary:true body is decoded from base64 before fetching', async () => {
  const payload = Buffer.from([1, 2, 3, 250]);
  await post({
    url: 'https://forum.obsidian.md/upload',
    method: 'POST',
    binary: true,
    body: payload.toString('base64'),
  });
  assert.equal(fetchCalls.length, 1);
  const sent = fetchCalls[0].init.body;
  assert.ok(Buffer.isBuffer(sent) || sent instanceof Uint8Array);
  assert.deepEqual(Buffer.from(sent), payload);
});

test('per-IP rate limit: 30/min pass, the 31st → 429 with Retry-After', async () => {
  let ok = 0;
  for (let i = 0; i < 30; i++) {
    const res = await post({ url: 'https://obsidian.md/favicon.ico' }, { ip: '5.5.5.5' });
    assert.equal(res.status, 200);
    ok++;
  }
  const limited = await post({ url: 'https://obsidian.md/favicon.ico' }, { ip: '5.5.5.5' });
  assert.equal(ok, 30);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');

  // a different caller is unaffected
  const other = await post({ url: 'https://obsidian.md/favicon.ico' }, { ip: '6.6.6.6' });
  assert.equal(other.status, 200);
});

test('requests without a client IP bypass the shared bucket', async () => {
  for (let i = 0; i < 35; i++) {
    const res = await post({ url: 'https://obsidian.md/favicon.ico' }, { ip: '' });
    assert.equal(res.status, 200, `request ${i}`);
  }
});
