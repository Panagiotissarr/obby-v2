// The optimistic-concurrency rules for POST /sync/v1/commit — one
// implementation, shared by both stores, so "what counts as a conflict" can
// never drift between memory (dev) and Postgres (production).
//
// Contract
// --------
// Every operation carries `baseHash`: the hash this device last synced for
// that path (null = "I believe the server has nothing there"). The server
// compares it to the path's *effective* hash (null for a tombstone or an
// absent row):
//
//   change   apply when  effective == baseHash   (nothing changed since we looked)
//                     or effective == hash       (server already has this exact content)
//            otherwise  conflict  → server's current state is reported back;
//                       the client keeps its own content under a
//                       conflict-copy name (see run-sync.js).
//   deletion apply when  effective == baseHash
//                     or effective == null       (already gone — deletions are
//                                                 idempotent, both sides agree)
//            otherwise  conflict  (the other device edited what we deleted)
//
// Nothing is ever silently overwritten: a conflict always reports the server
// state so the client can preserve both sides.

export function effectiveHash(row) {
  return row && !row.deleted ? row.hash : null;
}

// currentRows: Map<path, {hash, size, deleted}> — the rows FOR the touched
// paths only, as read (and locked) by the store.
// Returns { applied: [op...], conflicts: [{path, hash, size, deleted}...] }.
export function planCommit(currentRows, changes, deletions) {
  const applied = [];
  const conflicts = [];

  for (const change of changes) {
    const row = currentRows.get(change.path);
    const effective = effectiveHash(row);
    if (effective === change.hash || effective === change.baseHash) {
      applied.push({ kind: 'change', path: change.path, hash: change.hash, size: change.size });
    } else {
      conflicts.push({
        path: change.path,
        hash: effective,
        size: effective === null ? 0 : row.size,
        deleted: effective === null,
      });
    }
  }

  for (const deletion of deletions) {
    const row = currentRows.get(deletion.path);
    const effective = effectiveHash(row);
    if (effective === null || effective === deletion.baseHash) {
      applied.push({ kind: 'deletion', path: deletion.path });
    } else {
      conflicts.push({
        path: deletion.path,
        hash: effective,
        size: row.size,
        deleted: false,
      });
    }
  }

  return { applied, conflicts };
}
