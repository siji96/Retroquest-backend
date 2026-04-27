// Apply dev-db/schema.sql + seed.sql to Supabase via direct Postgres connection.
// Usage: node dev-db/apply.js [--schema-only | --seed-only]
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL;
const DB_PASS      = process.env.SUPABASE_DB_PASSWORD;

if (!SUPABASE_URL || !DB_PASS) {
  console.error('Missing SUPABASE_URL or SUPABASE_DB_PASSWORD in .env');
  process.exit(1);
}

const ref = SUPABASE_URL.replace(/^https?:\/\//, '').split('.')[0];

// Try direct connection first (db.<ref>.supabase.co:5432), fall back to pooler on IPv6 failure.
// Supabase transaction pooler (port 6543) — routed via region-specific subdomain.
// `sslmode` omitted: recent pg treats `require` as `verify-full`; we pass ssl opts below instead.
const pooler = (host, port = 6543) =>
  `postgresql://postgres.${ref}:${encodeURIComponent(DB_PASS)}@${host}:${port}/postgres`;

async function connect() {
  const candidates = [
    ['pooler aws-1 Tokyo:6543',    pooler('aws-1-ap-northeast-1.pooler.supabase.com', 6543)],
    ['pooler aws-1 Tokyo:5432',    pooler('aws-1-ap-northeast-1.pooler.supabase.com', 5432)],
    ['pooler aws-1 Singapore:6543',pooler('aws-1-ap-southeast-1.pooler.supabase.com', 6543)],
    ['pooler aws-0 Singapore:6543',pooler('aws-0-ap-southeast-1.pooler.supabase.com', 6543)],
  ];
  for (const [label, uri] of candidates) {
    try {
      const client = new pg.Client({ connectionString: uri, ssl: { rejectUnauthorized: false } });
      await client.connect();
      console.log(`✓ connected via ${label}`);
      return client;
    } catch (e) {
      console.log(`✗ ${label} failed — ${e.code || ''} ${e.message}`);
    }
  }
  throw new Error('Could not connect via any known route');
}

const FLAGS = new Set(process.argv.slice(2));
const doSchema = !FLAGS.has('--seed-only');
const doSeed   = !FLAGS.has('--schema-only');

const client = await connect();
try {
  if (doSchema) {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    console.log('• applying schema.sql …');
    await client.query(sql);
    console.log('✓ schema applied');
  }
  if (doSeed) {
    const sql = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8');
    console.log('• applying seed.sql …');
    await client.query(sql);
    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM ice_questions WHERE room_id IS NULL');
    console.log(`✓ seed applied — ${rows[0].n} default ice_questions`);
  }
} finally {
  await client.end();
}
