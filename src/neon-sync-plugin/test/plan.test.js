// The plugin's decision table and pure helpers (main.js exports them as
// statics so this suite can exercise them without Obsidian). Vectors mirror
// src/client-mobile/test/plan-sync.test.js — same server, same rules, so a
// change to the table must be made in BOTH files (planSync is a verbatim
// copy of src/client-mobile/sync/plan-sync.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Plugin = require('../main.js');
const { planSync, conflictCopyName, isInternalPath, tokenExpired, sha256Hex, bytesToBase64 } = Plugin;

const L1 = '1'.repeat(64);
const L2 = '2'.repeat(64);
const L3 = '3'.repeat(64);

function rem(path, hash, size = 10) {
  return { path, hash, size };
}
function loc(hash, size = 10) {
  return { hash, size };
}

// ── L⊥ R⊥ ─────────────────────────────────────────────────────────────────
test('both absent, never synced → nothing to do', () => {
  const plan = planSync([], {}, {});
  assert.deepEqual(plan, {
    downloads: [], pushChanges: [], pushDeletions: [], conflicts: [],
    setSynced: [], forgetSynced: [], localDeletes: [], inSync: 0,
  });
});

test('both absent, synced before → forgetSynced', () => {
  const plan = planSync([], {}, { 'gone.md': L1 });
  assert.deepEqual(plan.forgetSynced, ['gone.md']);
  assert.equal(plan.inSync, 0);
});

// ── L⊥ R=… (server-only) ─────────────────────────────────────────────────
test('new on server (never synced) → download', () => {
  const plan = planSync([rem('a.md', L1)], {}, {});
  assert.deepEqual(plan.downloads, [{ path: 'a.md', hash: L1, size: 10 }]);
});

test('we deleted it, server unchanged → push deletion', () => {
  const plan = planSync([rem('a.md', L1)], {}, { 'a.md': L1 });
  assert.deepEqual(plan.pushDeletions, [{ path: 'a.md', baseHash: L1 }]);
  assert.equal(plan.downloads.length, 0);
  assert.equal(plan.conflicts.length, 0);
});

test('we deleted it, server edited it → conflict (server wins, deletion abandoned)', () => {
  const plan = planSync([rem('a.md', L2)], {}, { 'a.md': L1 });
  assert.deepEqual(plan.conflicts, [{ path: 'a.md', hash: L2, size: 10, deleted: false }]);
  assert.equal(plan.downloads.length, 0);
});

// ── L=… R⊥ (local-only) ──────────────────────────────────────────────────
test('new local file (never synced) → push with base null', () => {
  const plan = planSync([], { 'a.md': loc(L1) }, {});
  assert.deepEqual(plan.pushChanges, [{ path: 'a.md', hash: L1, size: 10, baseHash: null }]);
});

test('server deleted it, local untouched → conform (delete locally)', () => {
  const plan = planSync([], { 'a.md': loc(L1) }, { 'a.md': L1 });
  assert.deepEqual(plan.localDeletes, ['a.md']);
  assert.equal(plan.pushChanges.length, 0);
  assert.equal(plan.conflicts.length, 0);
});

test('server deleted it, we edited it → conflict, server state says deleted', () => {
  const plan = planSync([], { 'a.md': loc(L2) }, { 'a.md': L1 });
  assert.deepEqual(plan.conflicts, [{ path: 'a.md', hash: null, size: 0, deleted: true }]);
  assert.equal(plan.localDeletes.length, 0);
});

// ── L=R ───────────────────────────────────────────────────────────────────
test('identical and S agrees → inSync', () => {
  const plan = planSync([rem('a.md', L1)], { 'a.md': loc(L1) }, { 'a.md': L1 });
  assert.equal(plan.inSync, 1);
  assert.deepEqual(plan.downloads.concat(plan.pushChanges), []);
});

test('identical but S stale/absent → setSynced (keeps S from poisoning the next edit)', () => {
  const plan = planSync([rem('a.md', L1)], { 'a.md': loc(L1) }, {});
  assert.deepEqual(plan.setSynced, [{ path: 'a.md', hash: L1 }]);
  assert.equal(plan.inSync, 0);

  const plan2 = planSync([rem('a.md', L1)], { 'a.md': loc(L1) }, { 'a.md': L3 });
  assert.deepEqual(plan2.setSynced, [{ path: 'a.md', hash: L1 }]);
});

// ── L≠R ───────────────────────────────────────────────────────────────────
test('local untouched, server moved → download', () => {
  const plan = planSync([rem('a.md', L2)], { 'a.md': loc(L1) }, { 'a.md': L1 });
  assert.deepEqual(plan.downloads, [{ path: 'a.md', hash: L2, size: 10 }]);
  assert.equal(plan.pushChanges.length, 0);
});

test('server untouched, local moved → push change with base S', () => {
  const plan = planSync([rem('a.md', L1)], { 'a.md': loc(L2) }, { 'a.md': L1 });
  assert.deepEqual(plan.pushChanges, [{ path: 'a.md', hash: L2, size: 10, baseHash: L1 }]);
  assert.equal(plan.downloads.length, 0);
  assert.equal(plan.conflicts.length, 0);
});

test('both moved → conflict, server state reported, no upload attempted', () => {
  const plan = planSync([rem('a.md', L3)], { 'a.md': loc(L2) }, { 'a.md': L1 });
  assert.deepEqual(plan.conflicts, [{ path: 'a.md', hash: L3, size: 10, deleted: false }]);
  assert.equal(plan.pushChanges.length, 0);
  assert.equal(plan.downloads.length, 0);
});

test('never synced, both sides different → conflict (base would mismatch anyway)', () => {
  const plan = planSync([rem('a.md', L1)], { 'a.md': loc(L2) }, {});
  assert.deepEqual(plan.conflicts, [{ path: 'a.md', hash: L1, size: 10, deleted: false }]);
  assert.equal(plan.pushChanges.length, 0);
});

// ── mixed vault ───────────────────────────────────────────────────────────
test('a mixed vault classifies every path exactly once', () => {
  const plan = planSync(
    [
      rem('same.md', L1),
      rem('server-moved.md', L2),
      rem('client-moved.md', L1),
      rem('racy.md', L3),
      rem('we-deleted.md', L1),
      rem('server-new.md', L3),
    ],
    {
      'same.md': loc(L1),
      'server-moved.md': loc(L1),
      'client-moved.md': loc(L2),
      'racy.md': loc(L2),
      'client-new.md': loc(L3),
      'untouched-deleted.md': loc(L1),
    },
    {
      'same.md': L1,
      'server-moved.md': L1,
      'client-moved.md': L1,
      'racy.md': L1,
      'we-deleted.md': L1,
      'untouched-deleted.md': L1,
    }
  );

  assert.equal(plan.inSync, 1); // same.md
  assert.deepEqual(plan.downloads.map((d) => d.path), ['server-moved.md', 'server-new.md']);
  assert.deepEqual(plan.pushChanges.map((c) => c.path), ['client-moved.md', 'client-new.md']);
  assert.deepEqual(plan.pushDeletions.map((d) => d.path), ['we-deleted.md']);
  assert.deepEqual(plan.conflicts.map((c) => c.path), ['racy.md']);
  assert.deepEqual(plan.localDeletes, ['untouched-deleted.md']);
  assert.deepEqual(plan.forgetSynced, []);

  const actions =
    plan.downloads.length + plan.pushChanges.length + plan.pushDeletions.length +
    plan.conflicts.length + plan.setSynced.length + plan.forgetSynced.length +
    plan.localDeletes.length + plan.inSync;
  assert.equal(actions, 8);
});

// ── plugin-specific helpers ───────────────────────────────────────────────
test('conflictCopyName matches the run-sync naming scheme', () => {
  assert.equal(conflictCopyName('dir/note.md', '20260927120000', 1), 'dir/note.conflict-20260927120000.md');
  assert.equal(conflictCopyName('dir/note.md', '20260927120000', 2), 'dir/note.conflict-20260927120000-2.md');
  assert.equal(conflictCopyName('note', '20260927120000', 1), 'note.conflict-20260927120000');
  assert.equal(conflictCopyName('a.b/note', '20260927120000', 1), 'a.b/note.conflict-20260927120000');
  assert.equal(conflictCopyName('.hidden.md', '20260927120000', 1), '.hidden.conflict-20260927120000.md');
});

test('isInternalPath skips Obsidian bookkeeping, keeps normal notes', () => {
  assert.equal(isInternalPath('.obsidian/app.json'), true);
  assert.equal(isInternalPath('sub/.trash/x.md'), true);
  assert.equal(isInternalPath('.gitignore'), true);
  assert.equal(isInternalPath('notes/a.md'), false);
  assert.equal(isInternalPath('a..b.md'), false);
});

test('tokenExpired: mpv1 expiry honoured, other token shapes pass', () => {
  const future = ['mpv1', 'bmFtZQ', String(Date.now() + 1000 * 60 * 60 * 24), 'sig'].join('.');
  const past = ['mpv1', 'bmFtZQ', String(Date.now() - 1000), 'sig'].join('.');
  assert.equal(tokenExpired(future), false);
  assert.equal(tokenExpired(past), true);
  assert.equal(tokenExpired('3b49cd508f77bd8cd0d75ef1ccd5a3e27f89ea3817dc6d55'), false); // global SYNC_TOKEN
  assert.equal(tokenExpired('mpv1.only.two'), true); // malformed
  assert.equal(tokenExpired(''), true);
  assert.equal(tokenExpired(null), true);
});

test('sha256Hex matches the known vector (WebCrypto path works under Node)', async () => {
  const hex = await sha256Hex(Buffer.from('abc'));
  assert.equal(hex, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('bytesToBase64 chunked encoding (large buffers stack-safe)', () => {
  assert.equal(bytesToBase64(new TextEncoder().encode('hello')), 'aGVsbG8=');
  const big = new Uint8Array(200000);
  const out = bytesToBase64(big);
  assert.equal(out.length, Math.ceil(big.length / 3) * 4);
});
