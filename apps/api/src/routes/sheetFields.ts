import { Hono } from 'hono';
import {
  layoutSheetFields,
  normalizeForMatch,
  reorderSheetFieldsSchema,
  saveSheetFieldSchema,
  SheetLayoutOverflowError,
  type SheetField,
  type SheetFieldDef,
  type SheetFieldSizeClass,
  type ZoneType,
} from '@scansign/shared';
import { db } from '../lib/supabase.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { requireAuth, type AppBindings } from '../lib/auth.js';
import { audit } from '../lib/audit.js';

/**
 * The owner's capture-sheet fields ("repères") — what used to be the
 * hardcoded `ATTESTATION_SHEET_V1` in packages/shared/src/captureSheet.ts.
 *
 * Position is never taken from the client: every mutation recomputes the
 * whole layout with `layoutSheetFields` (pure, in @scansign/shared) and
 * persists the result, so the PDF the console draws and the sheet the
 * detector reads always agree. The layout is computed once, before any
 * write, so an overflow (too many fields for one page) is rejected without
 * ever touching the database.
 */
export const sheetFieldRoutes = new Hono<AppBindings>();
sheetFieldRoutes.use('*', requireAuth);

interface SheetFieldRow {
  owner_id: string;
  key: string;
  title: string;
  label: string;
  short_label: string;
  hint: string;
  type: string;
  size_class: string;
  targets: string[];
  rect_x: number;
  rect_y: number;
  rect_w: number;
  rect_h: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const toModel = (row: SheetFieldRow) => ({
  key: row.key,
  title: row.title,
  label: row.label,
  shortLabel: row.short_label,
  hint: row.hint,
  type: row.type as ZoneType,
  sizeClass: row.size_class as SheetFieldSizeClass,
  targets: row.targets,
  rect: { x: row.rect_x, y: row.rect_y, width: row.rect_w, height: row.rect_h },
  sortOrder: row.sort_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const rowToDef = (row: SheetFieldRow): SheetFieldDef => ({
  key: row.key,
  title: row.title,
  label: row.label,
  shortLabel: row.short_label,
  hint: row.hint,
  type: row.type as ZoneType,
  sizeClass: row.size_class as SheetFieldSizeClass,
  targets: row.targets,
});

const loadAll = async (ownerId: string): Promise<SheetFieldRow[]> => {
  const { data } = await db
    .from('sheet_fields')
    .select('*')
    .eq('owner_id', ownerId)
    .order('sort_order', { ascending: true })
    .returns<SheetFieldRow[]>();
  return data ?? [];
};

/** Lay out `defs` or throw a 400 — never a raw overflow error past this point. */
const layoutOrThrow = (defs: readonly SheetFieldDef[]): SheetField[] => {
  try {
    return layoutSheetFields(defs);
  } catch (error) {
    if (error instanceof SheetLayoutOverflowError) {
      throw badRequest(error.message, 'SHEET_LAYOUT_OVERFLOW');
    }
    throw error;
  }
};

/** Write back the rects `layoutOrThrow` computed. Called only once it has succeeded. */
const persistRects = async (ownerId: string, placed: readonly SheetField[]): Promise<void> => {
  for (const field of placed) {
    await db
      .from('sheet_fields')
      .update({
        rect_x: field.rect.x,
        rect_y: field.rect.y,
        rect_w: field.rect.width,
        rect_h: field.rect.height,
      })
      .eq('owner_id', ownerId)
      .eq('key', field.id);
  }
};

/** A short, stable, URL-safe key from a label — 'signature_2' stays free for legacy fields. */
const keyFrom = (label: string, taken: ReadonlySet<string>): string => {
  const base = normalizeForMatch(label).replace(/\s+/g, '-').slice(0, 40) || 'repere';
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
};

sheetFieldRoutes.get('/', async (c) => {
  const user = c.get('user');
  return c.json({ items: (await loadAll(user.id)).map(toModel) });
});

sheetFieldRoutes.post('/', async (c) => {
  const user = c.get('user');
  const parsed = saveSheetFieldSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest('Repère invalide.', 'BAD_REQUEST', parsed.error.issues);

  const existing = await loadAll(user.id);
  const key = keyFrom(parsed.data.label, new Set(existing.map((r) => r.key)));
  const def: SheetFieldDef = {
    key,
    title: parsed.data.label.toUpperCase(),
    label: parsed.data.label,
    shortLabel: parsed.data.shortLabel,
    hint: parsed.data.hint,
    type: parsed.data.type,
    sizeClass: parsed.data.sizeClass,
    targets: parsed.data.targets,
  };
  // Computed before any write: an owner who adds one field too many gets a
  // clear "won't fit" instead of a half-created repère.
  const placed = layoutOrThrow([...existing.map(rowToDef), def]);
  const rect = placed.find((f) => f.id === key)!.rect;

  const { error } = await db.from('sheet_fields').insert({
    owner_id: user.id,
    key,
    title: def.title,
    label: def.label,
    short_label: def.shortLabel,
    hint: def.hint,
    type: def.type,
    size_class: def.sizeClass,
    targets: def.targets,
    rect_x: rect.x,
    rect_y: rect.y,
    rect_w: rect.width,
    rect_h: rect.height,
    sort_order: existing.length,
  });
  if (error) throw badRequest(error.message);
  await persistRects(user.id, placed);

  await audit({ ownerId: user.id, action: 'sheetField.created', metadata: { key } });
  return c.json({ items: (await loadAll(user.id)).map(toModel) }, 201);
});

sheetFieldRoutes.put('/reorder', async (c) => {
  const user = c.get('user');
  const parsed = reorderSheetFieldsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest('Ordre invalide.', 'BAD_REQUEST', parsed.error.issues);

  const existing = await loadAll(user.id);
  const byKey = new Map(existing.map((r) => [r.key, r]));
  const sameSet =
    parsed.data.keys.length === existing.length && parsed.data.keys.every((k) => byKey.has(k));
  if (!sameSet) {
    throw badRequest('La liste doit contenir exactement les repères existants.', 'BAD_REQUEST');
  }

  const ordered = parsed.data.keys.map((k) => byKey.get(k)!);
  const placed = layoutOrThrow(ordered.map(rowToDef));

  for (let i = 0; i < ordered.length; i++) {
    await db
      .from('sheet_fields')
      .update({ sort_order: i })
      .eq('owner_id', user.id)
      .eq('key', ordered[i]!.key);
  }
  await persistRects(user.id, placed);

  await audit({ ownerId: user.id, action: 'sheetField.reordered' });
  return c.json({ items: (await loadAll(user.id)).map(toModel) });
});

sheetFieldRoutes.put('/:key', async (c) => {
  const user = c.get('user');
  const key = c.req.param('key');
  const existing = await loadAll(user.id);
  if (!existing.some((r) => r.key === key)) throw notFound('Repère introuvable.');

  const parsed = saveSheetFieldSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest('Repère invalide.', 'BAD_REQUEST', parsed.error.issues);

  const updated: SheetFieldDef = {
    key,
    title: parsed.data.label.toUpperCase(),
    label: parsed.data.label,
    shortLabel: parsed.data.shortLabel,
    hint: parsed.data.hint,
    type: parsed.data.type,
    sizeClass: parsed.data.sizeClass,
    targets: parsed.data.targets,
  };
  const placed = layoutOrThrow(existing.map((r) => (r.key === key ? updated : rowToDef(r))));

  await db
    .from('sheet_fields')
    .update({
      title: updated.title,
      label: updated.label,
      short_label: updated.shortLabel,
      hint: updated.hint,
      type: updated.type,
      size_class: updated.sizeClass,
      targets: updated.targets,
    })
    .eq('owner_id', user.id)
    .eq('key', key);
  await persistRects(user.id, placed);

  await audit({ ownerId: user.id, action: 'sheetField.updated', metadata: { key } });
  return c.json({ items: (await loadAll(user.id)).map(toModel) });
});

sheetFieldRoutes.delete('/:key', async (c) => {
  const user = c.get('user');
  const key = c.req.param('key');
  const existing = await loadAll(user.id);
  if (!existing.some((r) => r.key === key)) throw notFound('Repère introuvable.');

  const { data: ownerTemplates } = await db
    .from('templates')
    .select('id, sheet_field')
    .eq('owner_id', user.id)
    .returns<Array<{ id: string; sheet_field: string | null }>>();
  const templates = ownerTemplates ?? [];
  const usedByTemplate = templates.some((t) => t.sheet_field === key);

  let usedByZone = false;
  const templateIds = templates.map((t) => t.id);
  if (templateIds.length > 0) {
    const { data: zones } = await db
      .from('template_zones')
      .select('id')
      .in('template_id', templateIds)
      .eq('sheet_field', key)
      .limit(1);
    usedByZone = (zones?.length ?? 0) > 0;
  }
  if (usedByTemplate || usedByZone) {
    throw conflict(
      'Des templates utilisent encore ce repère — changez leur case avant de le supprimer.',
      'SHEET_FIELD_IN_USE',
    );
  }

  const placed = layoutOrThrow(existing.filter((r) => r.key !== key).map(rowToDef));

  await db.from('sheet_fields').delete().eq('owner_id', user.id).eq('key', key);
  await persistRects(user.id, placed);

  await audit({ ownerId: user.id, action: 'sheetField.deleted', metadata: { key } });
  return c.json({ items: (await loadAll(user.id)).map(toModel) });
});
