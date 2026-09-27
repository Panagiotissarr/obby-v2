// lib/claims.js - scrypt password verifiers and mpv1 vault-scoped tokens.

import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOKEN_TTL_MS,
  assertVaultName,
  hashPassword,
  issueVaultToken,
  verifyPassword,
  verifyVaultToken,
} from '../lib/claims.js';
import { SyncError } from '../lib/errors.js';

const KEY = 'test-secret-token';

test('vault name validation - URL-safe names only', () => {
  assert.equal(assertVaultName('sarris'), 'sarris');
  assert.equal(assertVaultName('My-Vault_1.2'), 'My-Vault_1.2');
  assert.equal(assertVaultName('a'.repeat(64)), 'a'.repeat(64));
  const bad = ['', 'a'.repeat(65), 'has space', 'slash/here', 'ünïcode', '../etc', null, 42, undefined];
  for (const value of bad) {
    assert.throws(
      () => assertVaultName(value),
      (err) => err instanceof SyncError && err.status === 400,
      `expected ${JSON.stringify(value)} to be rejected`
    );
  }
});

test('password verifier roundtrip - same password passes, others fail', () => {
  const { salt, hash } = hashPassword('correct horse battery');
  assert.equal(salt.length, 32); // 16 bytes hex
  assert.equal(hash.length, 128); // 64 bytes hex
  assert.equal(verifyPassword('correct horse battery', salt, hash), true);
  assert.equal(verifyPassword('wrong password 123', salt, hash), false);

  const second = hashPassword('correct horse battery');
  assert.notEqual(second.salt, salt); // per-hash salt
  assert.equal(verifyPassword('correct horse battery', second.salt, second.hash), true);
});

test('verifyPassword rejects malformed input without throwing', () => {
  assert.equal(verifyPassword('x', 'zz', 'zz'), false);
  assert.equal(verifyPassword('x', '', ''), false);
  assert.equal(verifyPassword(null, 'aa', 'bb'), false);
  assert.equal(verifyPassword('x', null, null), false);
});

test('mpv1 token roundtrip - scoped to the claimed name', () => {
  const token = issueVaultToken('sarris', KEY);
  assert.match(token, /^mpv1\./);
  assert.equal(verifyVaultToken(token, KEY), 'sarris');
  // multi-vault names survive encoding
  assert.equal(verifyVaultToken(issueVaultToken('My-Vault_1.2', KEY), KEY), 'My-Vault_1.2');
});

test('mpv1 token rejected without the key - wrong key, missing key, garbage', () => {
  const token = issueVaultToken('sarris', KEY);
  assert.equal(verifyVaultToken(token, 'other-key'), null);
  assert.equal(verifyVaultToken(token, ''), null);
  assert.equal(verifyVaultToken('', KEY), null);
  assert.equal(verifyVaultToken(null, KEY), null);
  assert.equal(verifyVaultToken(undefined, KEY), null);
  assert.equal(verifyVaultToken(12345, KEY), null);
  assert.equal(verifyVaultToken('mpv1.only.two', KEY), null);
  assert.equal(verifyVaultToken('Basic ' + token, KEY), null);
  assert.equal(issueVaultToken('sarris', ''), null); // fail-closed: no key, no token
});

test('tampering with any part invalidates the signature', () => {
  const token = issueVaultToken('sarris', KEY);
  const parts = token.split('.');
  assert.equal(parts.length, 4);

  const renamed = ['mpv1', Buffer.from('other', 'utf8').toString('base64url'), parts[2], parts[3]].join('.');
  assert.equal(verifyVaultToken(renamed, KEY), null);

  const extended = [parts[0], parts[1], String(Number(parts[2]) + 1e9), parts[3]].join('.');
  assert.equal(verifyVaultToken(extended, KEY), null);

  const resigned = [parts[0], parts[1], parts[2], parts[3].slice(0, -2) + 'aa'].join('.');
  assert.equal(verifyVaultToken(resigned, KEY), null);

  assert.equal(verifyVaultToken(token + 'x', KEY), null);
});

test('a correctly signed token carrying an invalid name is rejected', () => {
  const exp = String(Date.now() + TOKEN_TTL_MS);
  const namePart = Buffer.from('bad name', 'utf8').toString('base64url');
  const payload = `mpv1.${namePart}.${exp}`;
  const sig = createHmac('sha256', KEY).update(payload).digest('base64url');
  assert.equal(verifyVaultToken(`${payload}.${sig}`, KEY), null);
});

test('expired tokens are rejected', () => {
  const token = issueVaultToken('sarris', KEY);
  assert.equal(verifyVaultToken(token, KEY), 'sarris'); // sanity: valid now
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + TOKEN_TTL_MS + 1000;
    assert.equal(verifyVaultToken(token, KEY), null);
  } finally {
    Date.now = realNow;
  }
});
