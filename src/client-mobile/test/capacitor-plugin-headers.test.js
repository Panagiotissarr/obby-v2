'use strict';

/**
 * capacitor-plugin-headers.test.js
 *
 * `Capacitor.Plugins.<Name>` is a Proxy created by registerPlugin() inside
 * app.js (Obsidian's own bundle). For every method it looks up the plugin's
 * entry in `Capacitor.PluginHeaders` and, when the method is NOT declared
 * there, rejects with:
 *
 *     "Keyboard.hasPhysicalKeyboard()" is not implemented on android
 *
 * BEFORE our `cap.nativePromise` override — i.e. before the shim's own
 * implementation is ever consulted. A method implemented on the plugin object
 * but missing from its PluginHeaders entry is therefore dead code that still
 * throws on every call: exactly the bug that produced a console error on every
 * boot until 2026-09-28 (`hasPhysicalKeyboard` shipped on the Keyboard object
 * without a matching `pm(...)`).
 *
 * This test closes that hole for every plugin in the registry by reading the
 * shim as text (it is a browser IIFE — not loadable under node:test) and
 * comparing the two lists.
 */

const assert = require('assert/strict');
const test = require('node:test');
const fs = require('node:path');

const SHIM = fs.join(__dirname, '..', 'shims', 'capacitor-shim.js');
const src = require('node:fs').readFileSync(SHIM, 'utf8');

// index of the bracket that closes the one opened at `openIdx`
function matchBracket(str, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === open) depth++;
    else if (str[i] === close && --depth === 0) return i;
  }
  return -1;
}

// ── cap.PluginHeaders → { Name: [method, ...] } ────────────────────────────
function parseHeaders() {
  const decl = src.indexOf('cap.PluginHeaders = [');
  assert.notEqual(decl, -1, 'cap.PluginHeaders declaration not found');
  const open = src.indexOf('[', decl);
  const body = src.slice(open, matchBracket(src, open, '[', ']') + 1);

  const out = {};
  const entryRe = /\{\s*name:\s*'(\w+)',\s*methods:\s*\[([\s\S]*?)\]\s*,?\s*\}/g;
  for (let m; (m = entryRe.exec(body));) {
    const methods = [];
    const callRe = /\b(?:pm|cm)\('(\w+)'\)/g;
    for (let c; (c = callRe.exec(m[2]));) methods.push(c[1]);
    out[m[1]] = methods;
  }
  return out;
}

// ── `const plugins = { ... }` → the registry's plugin names ────────────────
function parseRegistry() {
  const decl = src.indexOf('const plugins = {');
  assert.notEqual(decl, -1, 'plugins registry not found');
  const open = src.indexOf('{', decl);
  const body = src.slice(open + 1, matchBracket(src, open, '{', '}'));
  const names = [];
  for (const m of body.matchAll(/^\s{4}(\w+),\s*$/gm)) names.push(m[1]);
  assert.ok(names.length > 0, 'plugins registry parsed no names');
  return names;
}

// ── `const <Name> = { ... }` → its top-level method names ──────────────────
// Returns null when the declaration is not a plain object literal (Filesystem
// is `new Proxy({}, …)` delegating to fsBackend() — covered by its own note in
// the Filesystem test below, not by this scan).
function parseImpl(name) {
  const declRe = new RegExp('^ {2}const ' + name + ' = ([^{\\n]+)', 'm');
  const decl = declRe.exec(src);
  if (!decl) return null;
  if (decl[1].trim().startsWith('new Proxy')) return null;

  const at = src.indexOf('{', decl.index); // the literal's own open brace
  const body = src.slice(at + 1, matchBracket(src, at, '{', '}'));

  // Top-level members are indented one level deeper than the literal's own
  // keys. `async requestUrl(opts) {` and `getInfo: () => …` both count.
  const methods = [];
  for (const m of body.matchAll(/^\s{4}(?:async\s+)?(\w+)\s*[:(]/gm)) methods.push(m[1]);
  return methods;
}

const headers = parseHeaders();
const registry = parseRegistry();

test('every registered plugin has a PluginHeaders entry', () => {
  const missing = registry.filter((n) => !headers[n]);
  assert.deepEqual(missing, [], 'registered without a PluginHeaders entry: ' + missing.join(', '));
});

test('every method on a plugin impl is declared in its PluginHeaders entry', () => {
  const failures = [];
  for (const name of registry) {
    const impl = parseImpl(name);
    if (!impl) continue; // Proxy-backed (Filesystem) — see Filesystem test
    const declared = headers[name];
    for (const method of impl) {
      if (!declared.includes(method)) failures.push(name + '.' + method);
    }
  }
  assert.deepEqual(failures, [],
    'implemented but NOT declared — these calls reject "not implemented on android": ' +
    failures.join(', '));
});

test('Filesystem header covers the HTTP + OPFS backends its Proxy delegates to', () => {
  // `Filesystem` is `new Proxy({}, get)` → fsBackend() picks HttpFilesystem
  // (server vaults) or OpfsStore (OPFS/folder vaults) at call time, so its
  // header must cover the union. Both expose the same async method surface —
  // assert the shared core rather than the whole list.
  const shared = ['readFile', 'writeFile', 'appendFile', 'deleteFile', 'mkdir',
    'readdir', 'stat', 'rename', 'copy', 'addListener'];
  const missing = shared.filter((m) => !headers.Filesystem.includes(m));
  assert.deepEqual(missing, [], 'Filesystem header missing: ' + missing.join(', '));
});

// The regression this file exists for.
test('Keyboard.hasPhysicalKeyboard is declared in PluginHeaders', () => {
  assert.ok(headers.Keyboard.includes('hasPhysicalKeyboard'),
    'app.js calls Keyboard.hasPhysicalKeyboard() on android; without the ' +
    'pm(...) entry Capacitor rejects it before the shim can answer');
});
