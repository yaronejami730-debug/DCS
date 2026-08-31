#!/usr/bin/env node
/** Download the cutouts of the most recent signing session, for eyeballing. */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../.env'), quiet: true });

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'scansign';

const { data: sessions } = await db
  .from('signing_sessions')
  .select('id, signature_image_path, stamp_image_path, status')
  .order('created_at', { ascending: false })
  .limit(1);

const s = sessions?.[0];
if (!s) { console.log('no sessions'); process.exit(1); }
console.log('session', s.id, s.status);

const out = process.argv[2] ?? resolve(here, 'fixtures', 'output');
mkdirSync(out, { recursive: true });

for (const [label, path] of [['signature', s.signature_image_path], ['stamp', s.stamp_image_path]]) {
  if (!path) { console.log(`${label}: none`); continue; }
  const { data, error } = await db.storage.from(bucket).download(path);
  if (error) { console.log(`${label}: ${error.message}`); continue; }
  const file = resolve(out, `${label}.png`);
  writeFileSync(file, Buffer.from(await data.arrayBuffer()));
  console.log(`${label} -> ${file}`);
}
