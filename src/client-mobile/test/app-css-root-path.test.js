'use strict';

/**
 * app-css-root-path.test.js
 *
 * Community plugins that read Obsidian's own stylesheet back out of the DOM do
 * so by scanning `document.styleSheets` for a `<link>` whose `href`
 * ATTRIBUTE is exactly "app.css" or "/app.css" — see callout-manager's
 * `viaDom()` fallback, which throws "Unable to find <link> element for
 * Obsidian's stylesheet" when neither matches. A nested href like
 * "/obsidian-mobile/app.css" is invisible to that lookup, so the plugin
 * silently loses its live theme-change reactivity on every boot.
 *
 * Stock Obsidian keeps its renderer assets next to the document, which is why
 * the root is the shape plugins expect. We serve the bundle from
 * /obsidian-mobile/ instead, so each target has to mirror the single file to
 * the root for the lookup to work.
 *
 * This test pins both halves of that contract: the href in index.html must be
 * the root shape, AND all three deployment targets must actually serve that
 * path. Changing either side alone — the href without a mirror, or a mirror
 * without the href — breaks the plugins again, silently, with no failing
 * build and no error in our own code.
 */

const assert = require('assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');

const read = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8');

const TARGETS = [
  {
    name: 'vercel build-assets.js',
    file: ['..', '..', 'deployments', 'vercel', 'scripts', 'build-assets.js'],
    // copyFile(<... vendor app.css>, path.join(PUBLIC_DIR, 'app.css'))
    serves: /PUBLIC_DIR,\s*'app\.css'/,
  },
  {
    name: 'cloudflare build-assets.sh',
    file: ['..', '..', 'deployments', 'cloudflare', 'scripts', 'build-assets.sh'],
    // cp "$MAIN_DIR/vendor/obsidian-mobile/app.css" "$PUBLIC_DIR/app.css"
    serves: /\$PUBLIC_DIR\/app\.css/,
  },
  {
    name: 'runtime-server index.js',
    file: ['..', '..', 'runtime-server', 'server', 'index.js'],
    // const ROOT_FILES = ['worker.js', 'sim.js', 'app.css']
    serves: /ROOT_FILES\s*=\s*\[[^\]]*'app\.css'/,
  },
];

test("index.html links Obsidian's stylesheet at the root path", () => {
  const html = read('..', 'index.html');
  const link = html.match(/<link\b[^>]*\bhref="([^"]*app\.css)"[^>]*>/);
  assert.ok(link, 'no <link> to app.css found in index.html');

  assert.ok(
    link[1] === '/app.css' || link[1] === 'app.css',
    `app.css href must be exactly "app.css" or "/app.css" (plugins compare the ` +
      `attribute literally), got "${link[1]}"`
  );
});

test('every deployment target serves app.css at the root', () => {
  for (const { name, file, serves } of TARGETS) {
    assert.ok(serves.test(read(...file)), `${name} does not mirror app.css to the site root`);
  }
});
