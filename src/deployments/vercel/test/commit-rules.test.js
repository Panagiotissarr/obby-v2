// Unit tests for the commit CAS rules — the heart of push conflict
// resolution. Both stores call into this, so its cases are the contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveHash, planCommit } from '../lib/commit-rules.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

function row(hash, size = 10, deleted = false) {
  return { hash, size, deleted };
}

test('effectiveHash: live row → hash, tombstone/absent → null', () => {
  assert.equal(effectiveHash(row(A)), A);
  assert.equal(effectiveHash(row(A, 10, true)), null);
  assert.equal(effectiveHash(undefined), null);
  assert.equal(effectiveHash(null), null);
});

test('change applies when nothing changed since we looked (effective == base)', () => {
  const rows = new Map([['note.md', row(A)]]);
  const { applied, conflicts } = planCommit(
    rows,
    [{ path: 'note.md', hash: B, size: 5, baseHash: A }],
    []
  );
  assert.equal(conflicts.length, 0);
  assert.deepEqual(applied, [{ kind: 'change', path: 'note.md', hash: B, size: 5 }]);
});

test('change applies when the server already has our content (effective == hash)', () => {
  // Retry after a network error: our first commit landed but we never heard
  // back. The content is identical, so re-applying is safe, not a conflict.
  const rows = new Map([['note.md', row(B)]]);
  const { applied, conflicts } = planCommit(
    rows,
    [{ path: 'note.md', hash: B, size: 5, baseHash: A }],
    []
  );
  assert.equal(conflicts.length, 0);
  assert.equal(applied.length, 1);
});

test('change on a never-synced path (no row, base null) applies', () => {
  const { applied, conflicts } = planCommit(
    new Map(),
    [{ path: 'new.md', hash: C, size: 3, baseHash: null }],
    []
  );
  assert.equal(conflicts.length, 0);
  assert.equal(applied.length, 1);
});

test('change conflicts when the server moved on — server state is reported', () => {
  const rows = new Map([['note.md', row(B, 42)]]);
  const { applied, conflicts } = planCommit(
    rows,
    [{ path: 'note.md', hash: C, size: 7, baseHash: A }],
    []
  );
  assert.equal(applied.length, 0);
  assert.deepEqual(conflicts, [{ path: 'note.md', hash: B, size: 42, deleted: false }]);
});

test('change against a path the server deleted conflicts (and says so)', () => {
  const rows = new Map([['note.md', row(B, 42, true)]]);
  const { applied, conflicts } = planCommit(
    rows,
    [{ path: 'note.md', hash: C, size: 7, baseHash: A }],
    []
  );
  assert.equal(applied.length, 0);
  assert.deepEqual(conflicts, [{ path: 'note.md', hash: null, size: 0, deleted: true }]);
});

test('change against a path we believe is absent, but the server has, conflicts', () => {
  // baseHash null = "I synced an empty manifest", yet the server has content.
  const rows = new Map([['note.md', row(B)]]);
  const { applied, conflicts } = planCommit(
    rows,
    [{ path: 'note.md', hash: C, size: 7, baseHash: null }],
    []
  );
  assert.equal(applied.length, 0);
  assert.equal(conflicts[0].hash, B);
});

test('deletion applies when the server still has what we last synced', () => {
  const rows = new Map([['note.md', row(A)]]);
  const { applied, conflicts } = planCommit(
    rows,
    [],
    [{ path: 'note.md', baseHash: A }]
  );
  assert.equal(conflicts.length, 0);
  assert.deepEqual(applied, [{ kind: 'deletion', path: 'note.md' }]);
});

test('deletion of an absent path is idempotent — applied, not a conflict', () => {
  const { applied, conflicts } = planCommit(new Map(), [], [{ path: 'gone.md', baseHash: A }]);
  assert.equal(conflicts.length, 0);
  assert.equal(applied.length, 1);
});

test('deletion of an already-deleted path is idempotent', () => {
  const rows = new Map([['note.md', row(A, 10, true)]]);
  const { applied, conflicts } = planCommit(rows, [], [{ path: 'note.md', baseHash: A }]);
  assert.equal(conflicts.length, 0);
  assert.equal(applied.length, 1);
});

test('deletion conflicts when the other device edited what we deleted', () => {
  const rows = new Map([['note.md', row(B, 99)]]);
  const { applied, conflicts } = planCommit(rows, [], [{ path: 'note.md', baseHash: A }]);
  assert.equal(applied.length, 0);
  assert.deepEqual(conflicts, [{ path: 'note.md', hash: B, size: 99, deleted: false }]);
});

test('a batch reports applied and conflicted paths independently', () => {
  const rows = new Map([
    ['stable.md', row(A)],
    ['racy.md', row(B)],
    ['doomed.md', row(C)],
  ]);
  const { applied, conflicts } = planCommit(
    rows,
    [
      { path: 'stable.md', hash: C, size: 1, baseHash: A }, // applies
      { path: 'racy.md', hash: C, size: 2, baseHash: A }, // conflicts
    ],
    [{ path: 'doomed.md', baseHash: A }] // conflicts: edited, not deleted
  );
  assert.deepEqual(applied.map((op) => op.path), ['stable.md']);
  assert.deepEqual(conflicts.map((c) => c.path), ['racy.md', 'doomed.md']);
});
