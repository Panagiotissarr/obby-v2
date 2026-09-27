// Password claims for name-addressed vaults (/vault/<name> links).
//
// A claim binds a vault NAME to a password verifier so the gate at
// /vault/<name> can answer three questions without any other auth:
//   - is this name claimed?   GET  /sync/v1/vaults/<name>   (public)
//   - claim it (first time)   POST {password} -> 201 + token
//   - unlock it               POST {password} -> 200 + token   (same route;
//                             the server tries claim-then-unlock in one hit)
//
// The password is verified with scrypt (per-vault salt, never stored in the
// clear) and, on success, exchanged for a scoped bearer token (`mpv1.*`) that
// authorizes ONLY that vault - see lib/auth.js. The global SYNC_TOKEN keeps
// working as the operator key and is the HMAC key for scoped tokens, so no
// new env var is needed. Losing a password has no reset path through the
// gate by design; the operator still holds the database + SYNC_TOKEN.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { SyncError } from './errors.js';

// Same charset as getVaultOrThrow's VAULT_RE (lib/http.js): the claim name IS
// the vault id the sync endpoints see in ?vault=.
export const VAULT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function assertVaultName(name) {
  if (typeof name !== 'string' || !VAULT_NAME_RE.test(name)) {
    throw new SyncError(400, `invalid vault name: ${JSON.stringify(String(name ?? '').slice(0, 64))}`);
  }
  return name;
}

const SCRYPT_KEYLEN = 64;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

export function verifyPassword(password, saltHex, hashHex) {
  try {
    if (typeof password !== 'string' || typeof saltHex !== 'string' || typeof hashHex !== 'string') {
      return false;
    }
    const expected = Buffer.from(hashHex, 'hex');
    if (expected.length !== SCRYPT_KEYLEN) return false;
    const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ── scoped tokens ───────────────────────────────────────────────────────────
// Format: mpv1.<base64url(name)>.<expMs>.<base64url(hmac)>
// HMAC-SHA256 over "mpv1.<name>.<exp>" keyed with the deployment's
// SYNC_TOKEN: stateless (no DB write per unlock), unforgeable without the
// key, expires after TOKEN_TTL_MS, and names in the token are constrained to
// VAULT_NAME_RE on verification.

const TOKEN_PREFIX = 'mpv1';
export const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export function issueVaultToken(name, key) {
  if (!key) return null;
  const exp = String(Date.now() + TOKEN_TTL_MS);
  const namePart = Buffer.from(name, 'utf8').toString('base64url');
  const payload = `${TOKEN_PREFIX}.${namePart}.${exp}`;
  const sig = createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// Returns the vault name the token is scoped to, or null (expired, tampered,
// malformed, or no key).
export function verifyVaultToken(token, key) {
  if (typeof token !== 'string' || !key) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) return null;

  const payload = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const expected = createHmac('sha256', key).update(payload).digest();
  let provided;
  try {
    provided = Buffer.from(parts[3], 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  const exp = Number(parts[2]);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;

  let name;
  try {
    name = Buffer.from(parts[1], 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!VAULT_NAME_RE.test(name)) return null;
  return name;
}
