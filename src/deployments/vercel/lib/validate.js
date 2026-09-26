// Input validation for /sync/v1 — paths and hashes arrive from the network,
// so everything is checked before it reaches the store.

import { MAX_PATH_LENGTH } from './config.js';
import { SyncError } from './http.js';

const HASH_RE = /^[0-9a-f]{64}$/;

// Vault-relative, '/'-separated, no traversal, no absolute paths, no
// backslashes (Obsidian paths are posix), no control characters. Segments
// are otherwise unrestricted — vault file names are frequently non-ASCII
// (this repo ships Hebrew docs), so this deliberately does NOT restrict a
// segment to printable ASCII.
function segmentIsBad(segment) {
  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i);
    if (code < 32 || code === 127) return true; // control chars + DEL
    const ch = segment.charAt(i);
    if (ch === '/' || ch === '\\') return true;
  }
  return false;
}

export function isValidHash(hash) {
  return typeof hash === 'string' && HASH_RE.test(hash);
}

export function isValidPath(path) {
  if (typeof path !== 'string') return false;
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return false;
  if (path.charAt(0) === '/' || path.charAt(path.length - 1) === '/') return false;
  const segments = path.split('/');
  for (const segment of segments) {
    if (!segment) return false;
    if (segment === '.' || segment === '..') return false;
    if (segmentIsBad(segment)) return false;
  }
  return true;
}

export function requireValidPath(path, label) {
  if (!isValidPath(path)) {
    throw new SyncError(400, `invalid ${label || 'path'}: ${JSON.stringify(path)}`);
  }
  return path;
}

export function requireValidHash(hash, label) {
  if (!isValidHash(hash)) {
    throw new SyncError(400, `invalid ${label || 'hash'}: ${JSON.stringify(hash)}`);
  }
  return hash;
}

// `baseHash` is the optimistic-concurrency token: the hash this device last
// synced for that path (`null` = never synced). Anything else is rejected
// outright — the store only ever compares it to the current server hash.
function normalizeBaseHash(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!isValidHash(value)) {
    throw new SyncError(400, `invalid baseHash: ${JSON.stringify(value)}`);
  }
  return value;
}

function asInt(value, label, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new SyncError(400, `invalid ${label}: ${JSON.stringify(value)}`);
  }
  return n;
}

// Parse and validate a commit body:
//   { changes: [{path, hash, size, baseHash?}],
//     deletions: [{path, baseHash?}] }
export function parseCommitBody(body, { maxOps, maxBlobBytes }) {
  if (!body || typeof body !== 'object') {
    throw new SyncError(400, 'body must be a JSON object');
  }
  const changes = body.changes === undefined ? [] : body.changes;
  const deletions = body.deletions === undefined ? [] : body.deletions;
  if (!Array.isArray(changes) || !Array.isArray(deletions)) {
    throw new SyncError(400, 'changes and deletions must be arrays');
  }
  if (changes.length + deletions.length > maxOps) {
    throw new SyncError(413, `too many operations (max ${maxOps} per commit)`);
  }

  const outChanges = changes.map((change, i) => {
    if (!change || typeof change !== 'object') {
      throw new SyncError(400, `changes[${i}] must be an object`);
    }
    return {
      path: requireValidPath(change.path, `changes[${i}].path`),
      hash: requireValidHash(change.hash, `changes[${i}].hash`),
      size: asInt(change.size, `changes[${i}].size`, 0, maxBlobBytes),
      baseHash: normalizeBaseHash(change.baseHash),
    };
  });

  const outDeletions = deletions.map((deletion, i) => {
    if (!deletion || typeof deletion !== 'object') {
      throw new SyncError(400, `deletions[${i}] must be an object`);
    }
    return {
      path: requireValidPath(deletion.path, `deletions[${i}].path`),
      baseHash: normalizeBaseHash(deletion.baseHash),
    };
  });

  // One operation per path per commit — a client that sent both a change and
  // a deletion for the same path would be relying on ordering the CAS rules
  // don't define (the store decides every op against the same snapshot).
  const seen = new Set();
  for (const op of [...outChanges, ...outDeletions]) {
    if (seen.has(op.path)) {
      throw new SyncError(400, `path appears more than once in commit: ${JSON.stringify(op.path)}`);
    }
    seen.add(op.path);
  }

  return { changes: outChanges, deletions: outDeletions };
}
