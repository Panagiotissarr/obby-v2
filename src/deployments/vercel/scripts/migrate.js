// Apply lib/schema.sql to DATABASE_URL — idempotent (every statement is
// IF NOT EXISTS). The sync functions apply the same schema lazily on first
// use (lib/store-pg.js ensureSchema), so this script is for explicit
// control: run it once after creating a Neon database, or in CI.
//
//   DATABASE_URL=postgres://… npm run migrate
//
// Uses the same TLS settings as the store: sslmode=require with SNI (Neon
// needs it to route), SYNC_PG_SSL_NO_VERIFY=1 to skip certificate
// verification behind a TLS-intercepting proxy.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('migrate: DATABASE_URL is not set (Neon connection string).');
  process.exit(1);
}

const noVerify =
  process.env.SYNC_PG_SSL_NO_VERIFY === '1' || process.env.SYNC_PG_SSL_NO_VERIFY === 'true';

const { default: pg } = await import('pg');
const client = new pg.Client({
  connectionString: databaseUrl,
  ssl: { sslmode: 'require', ...(noVerify ? { rejectUnauthorized: false } : {}) },
});

const schema = readFileSync(path.join(HERE, '..', 'lib', 'schema.sql'), 'utf8');
// Never echo credentials back at people running this in a terminal.
const redacted = databaseUrl.replace(/\/\/[^@]*@/, '//***@');

try {
  await client.connect();
  await client.query(schema);
  console.log(`migrate: schema applied — ${redacted}`);
} catch (err) {
  console.error('migrate: failed —', err.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
