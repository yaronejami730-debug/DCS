/**
 * Apply pending SQL migrations through the session pooler.
 *
 * The direct db.<ref>.supabase.co host is IPv6-only and many networks have no
 * IPv6 route, so this connects via the pooler on 5432 (session mode — needed to
 * hold the DDL transaction). Pass migration filename fragments as arguments.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const env = Object.fromEntries(
  readFileSync(resolve(root, '.env'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const only = process.argv.slice(2);
const dir = resolve(root, 'supabase/migrations');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)));

const direct = new URL(env.SUPABASE_DB_URL);
const ref = direct.hostname.replace(/^db\./, '').replace(/\.supabase\.co$/, '');
const client = new pg.Client({
  host: 'aws-1-eu-west-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: decodeURIComponent(direct.password),
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
});
await client.connect();
for (const file of files) {
  process.stdout.write(`-> ${file} ... `);
  try {
    await client.query('begin');
    await client.query(readFileSync(resolve(dir, file), 'utf8'));
    await client.query('commit');
    console.log('ok');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    console.log(`FAILED\n   ${e.message}`);
    await client.end();
    process.exit(1);
  }
}
await client.end();
console.log('done');
