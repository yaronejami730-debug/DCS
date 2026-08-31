import { Hono } from 'hono';
import { saveTemplateSchema, type Template } from '@scansign/shared';
import { db } from '../lib/supabase.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireAuth, type AppBindings } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { loadTemplateZones, zoneRowToModel, type TemplateRow, type ZoneRow } from '../services/templates.js';

export const templateRoutes = new Hono<AppBindings>();
templateRoutes.use('*', requireAuth);

interface FullTemplateRow extends TemplateRow {
  owner_id: string;
  created_at: string;
  updated_at: string;
}

const toModel = (row: FullTemplateRow, zones: ZoneRow[]): Template => ({
  id: row.id,
  ownerId: row.owner_id,
  name: row.name,
  documentHash: row.document_hash,
  filenamePattern: row.filename_pattern,
  pageCount: row.page_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  zones: zones.map(zoneRowToModel),
});

const load = async (id: string, ownerId: string): Promise<FullTemplateRow> => {
  const { data } = await db
    .from('templates')
    .select('*')
    .eq('id', id)
    .eq('owner_id', ownerId)
    .maybeSingle<FullTemplateRow>();
  if (!data) throw notFound('Template introuvable.');
  return data;
};

/** Replace a template's zones wholesale — the editor always sends the full set. */
const replaceZones = async (
  templateId: string,
  zones: Array<{ page: number; type: 'signature' | 'stamp'; rect: { x: number; y: number; width: number; height: number }; index: number }>,
): Promise<void> => {
  await db.from('template_zones').delete().eq('template_id', templateId);
  if (zones.length === 0) return;
  const { error } = await db.from('template_zones').insert(
    zones.map((z) => ({
      template_id: templateId,
      page: z.page,
      type: z.type,
      x: z.rect.x,
      y: z.rect.y,
      width: z.rect.width,
      height: z.rect.height,
      zone_index: z.index,
    })),
  );
  if (error) throw badRequest(`Zones invalides: ${error.message}`, 'TEMPLATE_ZONE_OUT_OF_RANGE');
};

templateRoutes.get('/', async (c) => {
  const user = c.get('user');
  const { data } = await db
    .from('templates')
    .select('*')
    .eq('owner_id', user.id)
    .order('updated_at', { ascending: false })
    .returns<FullTemplateRow[]>();

  const items = await Promise.all(
    (data ?? []).map(async (row) => toModel(row, await loadTemplateZones(row.id))),
  );
  return c.json({ items, total: items.length });
});

templateRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const row = await load(c.req.param('id'), user.id);
  return c.json(toModel(row, await loadTemplateZones(row.id)));
});

/**
 * A template stores zones, not a PDF. To re-open the editor we need something
 * to draw on, so point the caller at a document that already uses this template.
 */
templateRoutes.get('/:id/preview-document', async (c) => {
  const user = c.get('user');
  const template = await load(c.req.param('id'), user.id);
  const { data } = await db
    .from('documents')
    .select('id, filename, page_count')
    .eq('owner_id', user.id)
    .eq('template_id', template.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; filename: string; page_count: number }>();
  if (!data) throw notFound('Aucun document n’utilise encore ce template.');
  return c.json({ documentId: data.id, filename: data.filename, pageCount: data.page_count });
});

templateRoutes.post('/', async (c) => {
  const user = c.get('user');
  const parsed = saveTemplateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest('Template invalide.', 'BAD_REQUEST', parsed.error.issues);

  const { data, error } = await db
    .from('templates')
    .insert({
      owner_id: user.id,
      name: parsed.data.name,
      document_hash: parsed.data.documentHash ?? null,
      filename_pattern: parsed.data.filenamePattern ?? null,
      page_count: parsed.data.pageCount ?? null,
    })
    .select('*')
    .single<FullTemplateRow>();

  if (error || !data) throw badRequest(error?.message ?? 'Création impossible.');
  await replaceZones(data.id, parsed.data.zones);

  await audit({
    ownerId: user.id,
    action: 'template.created',
    metadata: { templateId: data.id, name: data.name, zones: parsed.data.zones.length },
  });

  return c.json(toModel(data, await loadTemplateZones(data.id)), 201);
});

templateRoutes.put('/:id', async (c) => {
  const user = c.get('user');
  const existing = await load(c.req.param('id'), user.id);
  const parsed = saveTemplateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest('Template invalide.', 'BAD_REQUEST', parsed.error.issues);

  const { data, error } = await db
    .from('templates')
    .update({
      name: parsed.data.name,
      document_hash: parsed.data.documentHash ?? null,
      filename_pattern: parsed.data.filenamePattern ?? null,
      page_count: parsed.data.pageCount ?? null,
    })
    .eq('id', existing.id)
    .select('*')
    .single<FullTemplateRow>();

  if (error || !data) throw badRequest(error?.message ?? 'Mise à jour impossible.');
  await replaceZones(data.id, parsed.data.zones);

  // Documents already matched to this template may have become valid again.
  await db
    .from('documents')
    .update({ status: 'ready', error_code: null, error_message: null })
    .eq('owner_id', user.id)
    .eq('template_id', data.id)
    .in('status', ['awaiting_template', 'error']);

  await audit({
    ownerId: user.id,
    action: 'template.updated',
    metadata: { templateId: data.id, zones: parsed.data.zones.length },
  });

  return c.json(toModel(data, await loadTemplateZones(data.id)));
});

templateRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const { error } = await db
    .from('templates')
    .delete()
    .eq('id', c.req.param('id'))
    .eq('owner_id', user.id);
  if (error) throw badRequest(error.message);
  return c.json({ ok: true });
});
