// plan-sync.js — the bidirectional decision table (pure, no I/O).
// L = local hash, R = remote hash, S = last-synced hash, ⊥ = absent.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { planSync } = require('../sync/plan-sync.js');

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
test('local untouched, server moved → download (pull row 4)', () => {
  const plan = planSync([rem('a.md', L2)], { 'a.md': loc(L1) }, { 'a.md': L1 });
  assert.deepEqual(plan.downloads, [{ path: 'a.md', hash: L2, size: 10 }]);
  assert.equal(plan.pushChanges.length, 0);
});

test('server untouched, local moved → push change with base S (pull row 5 + push)', () => {
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

test('never synced, both sides have different content → conflict (base would mismatch anyway)', () => {
  const plan = planSync([rem('a.md', L1)], { 'a.md': loc(L2) }, {});
  assert.deepEqual(plan.conflicts, [{ path: 'a.md', hash: L1, size: 10, deleted: false }]);
  assert.equal(plan.pushChanges.length, 0);
});

// ── batches / ordering ────────────────────────────────────────────────────
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

  // every local path + every remote path was consumed exactly once
  const actions =
    plan.downloads.length + plan.pushChanges.length + plan.pushDeletions.length +
    plan.conflicts.length + plan.setSynced.length + plan.forgetSynced.length +
    plan.localDeletes.length + plan.inSync;
  assert.equal(actions, 8); // 6 remote paths + 2 local-only paths
});

test('mixed vault: localDeletes and forgetSynced come out right too', () => {
  const plan = planSync(
    [rem('server-moved.md', L2)],
    { 'untouched-deleted.md': loc(L1) },
    { 'untouched-deleted.md': L1, 'gone-both.md': L2 }
  );
  assert.deepEqual(plan.downloads.map((d) => d.path), ['server-moved.md']);
  assert.deepEqual(plan.localDeletes, ['untouched-deleted.md']);
  assert.deepEqual(plan.forgetSynced, ['gone-both.md']);
});
