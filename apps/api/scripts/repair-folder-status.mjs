#!/usr/bin/env node
/**
 * Recompute folder status from the documents inside.
 *
 * Importing a document into an already-signed folder used to leave the folder
 * marked "completed" while the new document sat unsigned, so the badge claimed
 * work that had not happened. The import path now resets the folder; this
 * repairs the rows written before that.
 *
 *   node apps/api/scripts/repair-folder-status.mjs [--apply]
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

const { data: folders, error } = await db
  .from('folders')
  .select('id, name, status, documents (id, status)');
if (error) throw error;

let changed = 0;
for (const folder of folders ?? []) {
  const docs = folder.documents ?? [];
  if (docs.length === 0) continue;

  const allDone = docs.every((d) => d.status === 'completed');
  const anyError = docs.some((d) => d.status === 'error');

  let expected = folder.status;
  if (folder.status === 'completed' && !allDone) {
    // Some document is unsigned: the folder is not finished.
    expected = anyError ? 'error' : 'pending';
  }

  if (expected !== folder.status) {
    changed += 1;
    const unsigned = docs.filter((d) => d.status !== 'completed').length;
    console.log(
      `${folder.name}: ${folder.status} -> ${expected} (${unsigned}/${docs.length} non signé(s))`,
    );
    if (apply) {
      await db
        .from('folders')
        .update({ status: expected, completed_at: expected === 'completed' ? undefined : null })
        .eq('id', folder.id);
    }
  }
}

console.log(
  changed === 0
    ? 'Aucun dossier incohérent.'
    : apply
      ? `${changed} dossier(s) corrigé(s).`
      : `${changed} dossier(s) à corriger. Relancez avec --apply.`,
);
