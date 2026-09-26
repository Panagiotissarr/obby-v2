// In-memory store — the reference implementation of the store contract (see
// lib/store.js). Used by `npm run dev` (SYNC_STORE=memory, no Neon needed)
// and by the test suite; on a real deployment it would lose every byte on
// the next cold start, which is why SYNC_STORE must never be set there.

import { createHash } from 'node:crypto';
import { StoreError } from './errors.js';
import { planCommit } from './commit-rules.js';

export function createMemoryStore(limits = {}) {
  const maxBlobBytes = limits.maxBlobBytes ?? 64 * 1024 * 1024;
  const maxPartBytes = limits.maxPartBytes ?? 4 * 1024 * 1024;

  const blobs = new Map(); // hash -> {size, data: Buffer}
  const parts = new Map(); // hash -> Map<index, {total, size, data}>
  const files = new Map(); // vault -> Map<path, {hash, size, deleted}>
  const meta = new Map(); // vault -> rev

  function vaultFiles(vault) {
    let map = files.get(vault);
    if (!map) {
      map = new Map();
      files.set(vault, map);
    }
    return map;
  }

  function sha256Hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
  }

  return {
    kind: 'memory',

    async getManifest(vault, { after = '', limit = 2000 } = {}) {
      const map = files.get(vault) || new Map();
      const entries = [];
      for (const [path, row] of map) {
        if (row.deleted) continue;
        if (after && path <= after) continue; // JS `<` = UTF-16 order; consistent with the sort below
        entries.push({ path, size: row.size, hash: row.hash });
      }
      entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const hasMore = entries.length > limit;
      return {
        cursor: String(meta.get(vault) || 0),
        entries: entries.slice(0, limit),
        hasMore,
      };
    },

    async getBlob(hash) {
      return blobs.get(hash) || null;
    },

    async missingBlobs(hashes) {
      return hashes.filter((hash) => !blobs.has(hash));
    },

    async putBlobPart(hash, { index, total, size, data }) {
      if (blobs.has(hash)) return { stored: true }; // already there — idempotent
      if (size > maxBlobBytes) throw new StoreError('ETOOLARGE', `blob exceeds ${maxBlobBytes} bytes`);
      if (data.length > maxPartBytes) throw new StoreError('ETOOLARGE', `chunk exceeds ${maxPartBytes} bytes`);

      let byIndex = parts.get(hash);
      if (!byIndex) {
        byIndex = new Map();
        parts.set(hash, byIndex);
      }
      const existing = byIndex.get(index);
      if (existing && (existing.total !== total || existing.size !== size)) {
        byIndex.clear(); // same hash re-uploaded with different chunking — start over
      }
      byIndex.set(index, { total, size, data });

      if (byIndex.size < total) return { stored: false };

      const ordered = [];
      for (let i = 0; i < total; i++) {
        const part = byIndex.get(i);
        if (!part) return { stored: false }; // gaps — not complete yet
        ordered.push(part);
      }
      const assembled = Buffer.concat(ordered.map((p) => p.data));
      if (assembled.length !== ordered[0].size) {
        parts.delete(hash);
        throw new StoreError('ESIZE', 'assembled blob size does not match declared size');
      }
      if (sha256Hex(assembled) !== hash) {
        parts.delete(hash);
        throw new StoreError('EHASH', 'assembled blob does not match its hash');
      }
      if (!blobs.has(hash)) blobs.set(hash, { size: assembled.length, data: assembled });
      parts.delete(hash);
      return { stored: true };
    },

    async commit(vault, changes, deletions) {
      const map = vaultFiles(vault);
      const touched = new Map();
      for (const op of [...changes, ...deletions]) {
        const row = map.get(op.path);
        if (row) touched.set(op.path, row);
      }

      const { applied, conflicts } = planCommit(touched, changes, deletions);

      for (const op of applied) {
        if (op.kind === 'change') {
          map.set(op.path, { hash: op.hash, size: op.size, deleted: false });
        } else {
          const row = map.get(op.path);
          if (row) row.deleted = true; // absent path → no-op, nothing to tombstone
        }
      }

      let rev = meta.get(vault) || 0;
      if (applied.length > 0) {
        rev += 1;
        meta.set(vault, rev);
      }

      return { rev: String(rev), applied: applied.map((op) => op.path), conflicts };
    },

    async gc() {
      // no background sweeps needed — parts are dropped on assembly and
      // blobs are only ever written, never orphaned, in memory mode.
    },

    async close() {},
  };
}
