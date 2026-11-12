import {
  ATTESTATION_SHEET_V1,
  type CaptureSheetLayout,
  type SheetField,
  type ZoneType,
} from '@scansign/shared';
import { db } from '../lib/supabase.js';

interface SheetFieldRow {
  key: string;
  title: string;
  label: string;
  short_label: string;
  hint: string;
  type: string;
  targets: string[];
  rect_x: number;
  rect_y: number;
  rect_w: number;
  rect_h: number;
}

/**
 * The owner's capture sheet, as a `CaptureSheetLayout` the detector and the
 * PDF drawer both understand — built from `sheet_fields`, falling back to
 * the built-in `ATTESTATION_SHEET_V1` for an owner with no rows there (a
 * pre-migration edge case; every owner is seeded going forward).
 */
export const loadOwnerCaptureSheetLayout = async (ownerId: string): Promise<CaptureSheetLayout> => {
  const { data } = await db
    .from('sheet_fields')
    .select('key, title, label, short_label, hint, type, targets, rect_x, rect_y, rect_w, rect_h')
    .eq('owner_id', ownerId)
    .order('sort_order', { ascending: true })
    .returns<SheetFieldRow[]>();

  if (!data || data.length === 0) return ATTESTATION_SHEET_V1;

  const fields: SheetField[] = data.map((row) => ({
    id: row.key,
    title: row.title,
    label: row.label,
    shortLabel: row.short_label,
    hint: row.hint,
    type: row.type as ZoneType,
    targets: row.targets,
    rect: { x: row.rect_x, y: row.rect_y, width: row.rect_w, height: row.rect_h },
  }));

  return { id: `owner-${ownerId}`, title: ATTESTATION_SHEET_V1.title, fields };
};
