/**
 * Re-stamp a folder's documents, giving each one its own variant.
 *
 * Why this exists: the fallback that picked a variant for each document hashed
 * the document id modulo the folder's size. Hashing n documents into n buckets
 * collides almost always — two documents share an index half the time for a
 * pair, and a folder of four came out all-distinct only 9% of the time — so
 * folders were signed with duplicate, byte-identical signatures. The pipeline
 * now assigns by position and cannot collide; this repairs folders signed
 * before that.
 *
 * Regeneration is the same path as repositioning: the ORIGINAL PDF plus the
 * stored cutouts, through the same generator. The signature is not re-extracted
 * and no signed PDF is edited in place — each is rebuilt and replaced at its
 * own path, so links already handed out keep resolving.
 *
 *   pnpm --filter @scansign/api restamp <folderId>          # report only
 *   pnpm --filter @scansign/api restamp <folderId> --apply
 */
import {
  HANDWRITTEN_MARKS,
  processedPdfPath,
  type ZoneType,
} from '@scansign/shared';
import { generateSignedPdf, type PlacementZone } from '@scansign/pdf';
import { env } from '../src/env.js';
import { db } from '../src/lib/supabase.js';
import { downloadObject, uploadObject } from '../src/lib/storage.js';
import { zonesForDocument } from '../src/services/placement.js';
import { fallbackVariantIndex, variantAt, variantPlacement } from '../src/services/variants.js';

const folderId = process.argv[2];
const apply = process.argv.includes('--apply');

if (!folderId) {
  console.error('usage: restamp <folderId> [--apply]');
  process.exit(1);
}

const { data: folder } = await db
  .from('folders')
  .select('id, name, reference, owner_id')
  .eq('id', folderId)
  .maybeSingle<{ id: string; name: string; reference: number; owner_id: string }>();
if (!folder) {
  console.error('Folder not found.');
  process.exit(1);
}

/**
 * The session whose marks are on these documents.
 *
 * Newest completed one: a folder signed twice carries the latest signing, which
 * is what its PDFs show.
 */
const { data: session } = await db
  .from('signing_sessions')
  .select(
    'id, signature_image_path, stamp_image_path, mention_image_path, signature_stamp_image_path',
  )
  .eq('folder_id', folder.id)
  .eq('status', 'completed')
  .order('completed_at', { ascending: false })
  .limit(1)
  .maybeSingle<{
    id: string;
    signature_image_path: string | null;
    stamp_image_path: string | null;
    mention_image_path: string | null;
    signature_stamp_image_path: string | null;
  }>();

if (!session) {
  console.error('No completed signing session for this folder — nothing to re-stamp.');
  process.exit(1);
}

const cutouts: Partial<Record<ZoneType, Uint8Array>> = {};
for (const [mark, path] of [
  ['signature', session.signature_image_path],
  ['stamp', session.stamp_image_path],
  ['mention', session.mention_image_path],
  ['signature_stamp', session.signature_stamp_image_path],
] as Array<[ZoneType, string | null]>) {
  if (!path) continue;
  try {
    cutouts[mark] = await downloadObject(path);
  } catch {
    console.error(`Cutout missing in storage: ${path}. Cannot re-stamp this folder.`);
    process.exit(1);
  }
}

if (Object.keys(cutouts).length === 0) {
  console.error('This session kept no cutouts (retention) — the folder cannot be re-stamped.');
  process.exit(1);
}

const { data: documents } = await db
  .from('documents')
  .select('id, filename, status, storage_path, final_pdf_path, template_id, position')
  .eq('folder_id', folder.id)
  .order('position', { ascending: true })
  .returns<
    Array<{
      id: string;
      filename: string;
      status: string;
      storage_path: string;
      final_pdf_path: string | null;
      template_id: string | null;
      position: number;
    }>
  >();

const docs = documents ?? [];
console.log(`\nFolder "${folder.name}" #${folder.reference} — ${docs.length} document(s)`);
console.log(`Session ${session.id}, marks: ${Object.keys(cutouts).join(', ')}\n`);

const strength = env.SIGNATURE_VARIATION_STRENGTH;
let done = 0;

for (const [ordinal, doc] of docs.entries()) {
  if (doc.status !== 'completed' || !doc.final_pdf_path) {
    console.log(`  ${doc.filename}: not signed (${doc.status}) — skipped`);
    continue;
  }

  const { zones } = await zonesForDocument(doc);
  if (zones.length === 0) {
    console.log(`  ${doc.filename}: no zones — skipped`);
    continue;
  }

  const index = fallbackVariantIndex(ordinal);
  console.log(`  ${doc.filename}  ->  variante ${index}`);
  if (!apply) continue;

  const varied = async (mark: ZoneType): Promise<Uint8Array | null> => {
    const png = cutouts[mark];
    if (!png) return null;
    if (!env.SIGNATURE_VARIANTS || !HANDWRITTEN_MARKS.includes(mark)) return png;
    return variantAt(png, index);
  };

  const original = await downloadObject(doc.storage_path);
  const { bytes, placed } = await generateSignedPdf({
    pdfBytes: original,
    zones: zones.map<PlacementZone>((z) => ({ page: z.page, type: z.type, rect: z.rect })),
    signaturePng: await varied('signature'),
    stampPng: cutouts.stamp ?? null,
    mentionPng: await varied('mention'),
    combinedPng: await varied('signature_stamp'),
    fit: { fill: env.MARK_FILL, maxHeightOverflow: env.MARK_MAX_OVERFLOW },
    variation: env.SIGNATURE_VARIANTS
      ? variantPlacement(index, env.SIGNATURE_VARIATION_STRENGTH)
      : undefined,
  });

  // Same path as the original run, so links already handed out keep working.
  const outPath = processedPdfPath(folder.owner_id, doc.id);
  await uploadObject(outPath, bytes, 'application/pdf');
  await db
    .from('documents')
    .update({ final_pdf_path: outPath, error_code: null, error_message: null })
    .eq('id', doc.id);

  // Best-effort: only lands once the placement migration has run.
  await db
    .from('documents')
    .update({ signing_session_id: session.id, variant_index: index })
    .eq('id', doc.id);

  console.log(`     regenerated, ${placed} zone(s), ${bytes.byteLength} bytes`);
  done += 1;
}

console.log(
  apply
    ? `\nRe-stamped ${done} document(s) at variation strength ${strength}.`
    : '\nDry run. Re-run with --apply to rewrite these documents.',
);
