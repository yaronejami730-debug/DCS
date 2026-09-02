import { ZONE_TYPE } from '@scansign/shared';
import type { NormalizedRect, RequiredMarks, TemplateZone, ZoneType } from '@scansign/shared';
import { matchesFilenamePattern } from '@scansign/pdf';
import { db } from '../lib/supabase.js';

export interface TemplateRow {
  id: string;
  name: string;
  document_hash: string | null;
  filename_pattern: string | null;
  page_count: number | null;
  reusable: boolean;
  sheet_field?: string | null;
}

export interface ZoneRow {
  id: string;
  template_id: string;
  page: number;
  type: ZoneType;
  x: number;
  y: number;
  width: number;
  height: number;
  zone_index: number;
  sheet_field?: string | null;
}

export const zoneRowToModel = (row: ZoneRow): TemplateZone => ({
  id: row.id,
  templateId: row.template_id,
  page: row.page,
  type: row.type,
  rect: { x: row.x, y: row.y, width: row.width, height: row.height },
  index: row.zone_index,
  sheetField: row.sheet_field ?? null,
});

export const zoneRowToRect = (row: ZoneRow): NormalizedRect => ({
  x: row.x,
  y: row.y,
  width: row.width,
  height: row.height,
});

/**
 * Resolve which template describes an uploaded PDF.
 *
 * Order is deliberate and never falls back to something weaker when something
 * stronger is available:
 *   1. exact SHA-256 of the file bytes — cannot be fooled by a rename;
 *   2. filename pattern AND matching page count — both must agree;
 *   3. nothing: the document is parked in `awaiting_template` and the console
 *      asks the operator to configure it.
 *
 * A filename alone is never enough.
 */
export const findTemplateForDocument = async (params: {
  ownerId: string;
  documentHash: string;
  filename: string;
  pageCount: number;
}): Promise<{ template: TemplateRow; matchedBy: 'hash' | 'filename' } | null> => {
  const { ownerId, documentHash, filename, pageCount } = params;

  // An exact SHA-256 match is the strongest signal there is, so `reusable` does
  // not gate it: the very same bytes, already configured by this same owner,
  // describe this document by definition. Gating it here meant re-uploading a
  // file whose template existed parked the document in `awaiting_template`
  // forever, because nothing else was ever going to match it either.
  // `reusable` still gates the filename branch below, where a rename really
  // could drag in the wrong template.
  const { data: byHash } = await db
    .from('templates')
    .select('id, name, document_hash, filename_pattern, page_count, reusable')
    .eq('owner_id', ownerId)
    .eq('document_hash', documentHash)
    // Several templates can share a hash; prefer a reusable one, then the most
    // recently configured, so the pick is deterministic rather than arbitrary.
    .order('reusable', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<TemplateRow>();

  if (byHash) return { template: byHash, matchedBy: 'hash' };

  const { data: candidates } = await db
    .from('templates')
    .select('id, name, document_hash, filename_pattern, page_count, reusable')
    .eq('owner_id', ownerId)
    .eq('reusable', true)
    .not('filename_pattern', 'is', null)
    .returns<TemplateRow[]>();

  const match = (candidates ?? []).find(
    (t) =>
      t.filename_pattern !== null &&
      matchesFilenamePattern(filename, t.filename_pattern) &&
      t.page_count === pageCount,
  );

  return match ? { template: match, matchedBy: 'filename' } : null;
};

export const loadTemplateZones = async (templateId: string): Promise<ZoneRow[]> => {
  const { data } = await db
    .from('template_zones')
    .select('id, template_id, page, type, x, y, width, height, zone_index, sheet_field')
    .eq('template_id', templateId)
    .order('page', { ascending: true })
    .order('zone_index', { ascending: true })
    .returns<ZoneRow[]>();
  return data ?? [];
};

/**
 * Which marks a folder's templates actually call for.
 *
 * Asked before capturing, so the flow has exactly as many steps as the
 * documents need — two for signature + stamp, three when a "Lu et approuvé" is
 * also required — instead of asking for marks nobody wants.
 *
 * Counts, not booleans, because the console needs to know how many zones exist.
 * The share-link surface deliberately reduces this to a list of types before it
 * reaches the signer: a count of signature zones is a count of documents by
 * another name, and the signer is not entitled to that.
 */
export const requiredMarksForFolder = async (folderId: string): Promise<RequiredMarks> => {
  const { data: documents } = await db
    .from('documents')
    .select('template_id')
    .eq('folder_id', folderId)
    // A capture sheet has no zones by definition; including it would only ever
    // contribute zero and invites the reader to wonder whether it might not.
    .eq('role', 'to_sign')
    .returns<Array<{ template_id: string | null }>>();

  // Seeded from the list itself, so a type added later cannot be missed here.
  const counts: RequiredMarks = Object.fromEntries(
    ZONE_TYPE.map((t) => [t, 0]),
  ) as RequiredMarks;
  const seen = new Set<string>();

  for (const doc of documents ?? []) {
    if (!doc.template_id || seen.has(doc.template_id)) continue;
    seen.add(doc.template_id);
    for (const zone of await loadTemplateZones(doc.template_id)) {
      counts[zone.type] += 1;
    }
  }
  return counts;
};
