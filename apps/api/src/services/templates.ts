import type { NormalizedRect, TemplateZone, ZoneType } from '@scansign/shared';
import { matchesFilenamePattern } from '@scansign/pdf';
import { db } from '../lib/supabase.js';

export interface TemplateRow {
  id: string;
  name: string;
  document_hash: string | null;
  filename_pattern: string | null;
  page_count: number | null;
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
}

export const zoneRowToModel = (row: ZoneRow): TemplateZone => ({
  id: row.id,
  templateId: row.template_id,
  page: row.page,
  type: row.type,
  rect: { x: row.x, y: row.y, width: row.width, height: row.height },
  index: row.zone_index,
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

  const { data: byHash } = await db
    .from('templates')
    .select('id, name, document_hash, filename_pattern, page_count')
    .eq('owner_id', ownerId)
    .eq('document_hash', documentHash)
    .limit(1)
    .maybeSingle<TemplateRow>();

  if (byHash) return { template: byHash, matchedBy: 'hash' };

  const { data: candidates } = await db
    .from('templates')
    .select('id, name, document_hash, filename_pattern, page_count')
    .eq('owner_id', ownerId)
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
    .select('id, template_id, page, type, x, y, width, height, zone_index')
    .eq('template_id', templateId)
    .order('page', { ascending: true })
    .order('zone_index', { ascending: true })
    .returns<ZoneRow[]>();
  return data ?? [];
};
