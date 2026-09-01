#!/usr/bin/env node
/**
 * Complete documents whose signed PDF exists but whose row never caught up.
 *
 * The generator uploads the finished PDF to storage and *then* marks the row
 * `completed` with its path. supabase-js reports a failed update in its result
 * rather than throwing, so a rejected update was silent: the PDF sat in storage
 * while the document stayed at `processing` with `final_pdf_path` null —
 * invisible in the console and on the phone, with the folder cheerfully
 * reporting success. That is exactly what happened when two provenance columns
 * were added to the update before their migration had run.
 *
 * The pipeline no longer fails that way (the completion update is checked, and
 * provenance is written separately and tolerantly). This repairs the rows left
 * behind, and only where the evidence is unambiguous: a PDF really is in
 * storage at the path the generator would have used.
 *
 *   node apps/api/scripts/repair-stuck-documents.mjs          # report only
 *   node apps/api/scripts/repair-stuck-documents.mjs --apply  # fix them
 */
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../../../.env'), quiet: true });

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET = 'scansign' } =
  process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const apply = process.argv.includes('--apply');

const { data: stuck, error } = await db
  .from('documents')
  .select('id, owner_id, folder_id, filename, status, final_pdf_path')
  .in('status', ['processing'])
  .is('final_pdf_path', null);
if (error) throw error;

if (!stuck?.length) {
  console.log('No documents stuck at "processing" with no signed PDF.');
  process.exit(0);
}

console.log(`${stuck.length} document(s) stuck at "processing":\n`);

let repaired = 0;
const touchedFolders = new Set();

for (const doc of stuck) {
  // The path the generator would have written to, and the only one we will
  // attach: guessing at any other object risks pointing a document at somebody
  // else's PDF.
  const path = `processed/${doc.owner_id}/${doc.id}.pdf`;
  const { data: file } = await db.storage.from(SUPABASE_STORAGE_BUCKET).download(path);

  if (!file) {
    console.log(`  ${doc.filename}`);
    console.log(`    no PDF in storage — genuinely unfinished, left alone`);
    continue;
  }

  console.log(`  ${doc.filename}`);
  console.log(`    PDF found (${file.size} bytes) -> ${path}`);

  if (!apply) {
    console.log('    would mark completed');
    continue;
  }

  const { error: updateError } = await db
    .from('documents')
    .update({
      status: 'completed',
      final_pdf_path: path,
      error_code: null,
      error_message: null,
    })
    .eq('id', doc.id);

  if (updateError) {
    console.log(`    FAILED: ${updateError.message}`);
    continue;
  }
  console.log('    marked completed');
  repaired += 1;
  touchedFolders.add(doc.folder_id);
}

// A folder whose documents were stuck may itself have been left mid-flight.
// Recompute from the documents rather than assuming.
for (const folderId of touchedFolders) {
  const { data: docs } = await db.from('documents').select('status').eq('folder_id', folderId);
  const rows = docs ?? [];
  const done = rows.every((d) => d.status === 'completed');
  const anyError = rows.some((d) => d.status === 'error');
  const status = anyError ? 'error' : done ? 'completed' : 'in_progress';

  await db
    .from('folders')
    .update({
      status,
      completed_at: done ? new Date().toISOString() : null,
      ...(anyError ? {} : { error_code: null, error_message: null }),
    })
    .eq('id', folderId);
  console.log(`\nfolder ${folderId} -> ${status}`);
}

console.log(
  apply
    ? `\nRepaired ${repaired} document(s).`
    : '\nDry run. Re-run with --apply to write these changes.',
);
