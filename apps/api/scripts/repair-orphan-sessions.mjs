#!/usr/bin/env node
/**
 * Close signing sessions that were abandoned mid-capture.
 *
 * Per-mark capture used to open a new session for each mark, so a folder could
 * end up with one session holding the signature and another holding the
 * mention — and the one that was submitted had neither complete. The capture
 * flow now carries a single session throughout; this closes the rows left over.
 *
 *   node apps/api/scripts/repair-orphan-sessions.mjs [--apply]
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../../../.env'), quiet: true });

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const apply = process.argv.includes('--apply');

const { data: sessions, error } = await db
  .from('signing_sessions')
  .select('id, folder_id, status, capture_mode, created_at')
  .in('status', ['awaiting_photo', 'awaiting_regions'])
  .order('created_at', { ascending: false });
if (error) throw error;

// Within a folder, only the newest unfinished session can still be the live
// one; anything older was left behind.
const newestPerFolder = new Map();
for (const s of sessions ?? []) {
  if (!newestPerFolder.has(s.folder_id)) newestPerFolder.set(s.folder_id, s.id);
}

const stale = (sessions ?? []).filter((s) => newestPerFolder.get(s.folder_id) !== s.id);

for (const s of stale) {
  console.log(`${s.created_at.slice(0, 19)} [${s.capture_mode}] ${s.status} — session ${s.id.slice(0, 8)}`);
  if (apply) {
    await db
      .from('signing_sessions')
      .update({
        status: 'error',
        error_code: 'IMAGE_PROCESSING_FAILED',
        error_message: 'Capture abandonnée : une session plus récente l’a remplacée.',
      })
      .eq('id', s.id);
  }
}

console.log(
  stale.length === 0
    ? 'Aucune session orpheline.'
    : apply
      ? `${stale.length} session(s) close(s).`
      : `${stale.length} session(s) orpheline(s). Relancez avec --apply.`,
);
