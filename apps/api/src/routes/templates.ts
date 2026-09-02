import { Hono } from 'hono';
import { env } from '../env.js';
import {
  ZONE_TYPE_LABEL,
  saveTemplateSchema,
  templateSourcePdfPath,
  type Template,
  type ZoneType,
  ZONE_TYPE,
} from '@scansign/shared';
import { annotateTemplate, inspectPdf, looksLikePdf, sha256 } from '@scansign/pdf';
import { db } from '../lib/supabase.js';
import { downloadObject, signedUrl, uploadObject } from '../lib/storage.js';
import { badRequest, notFound, payloadTooLarge, unsupportedMedia } from '../lib/errors.js';
import { requireAuth, type AppBindings } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { loadTemplateZones, zoneRowToModel, type TemplateRow, type ZoneRow } from '../services/templates.js';

export const templateRoutes = new Hono<AppBindings>();
templateRoutes.use('*', requireAuth);

interface FullTemplateRow extends TemplateRow {
  owner_id: string;
  source_pdf_path: string | null;
  source_filename: string | null;
  created_at: string;
  updated_at: string;
}

const toModel = (row: FullTemplateRow, zones: ZoneRow[]): Template => ({
  id: row.id,
  ownerId: row.owner_id,
  name: row.name,
  reusable: row.reusable,
  documentHash: row.document_hash,
  filenamePattern: row.filename_pattern,
  pageCount: row.page_count,
  sourcePdfPath: row.source_pdf_path,
  sourceFilename: row.source_filename,
  sheetField: row.sheet_field ?? null,
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
  zones: Array<{
    page: number;
    type: ZoneType;
    rect: { x: number; y: number; width: number; height: number };
    index: number;
    sheetField?: string | null;
  }>,
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
      sheet_field: z.sheetField ?? null,
    })),
  );
  if (error) throw badRequest(`Zones invalides: ${error.message}`, 'TEMPLATE_ZONE_OUT_OF_RANGE');
};

templateRoutes.get('/', async (c) => {
  const user = c.get('user');
  // The library lists reusable templates only; one-off ones stay attached to
  // their document and would just be noise here. ?all=true shows everything.
  const query = db
    .from('templates')
    .select('*')
    .eq('owner_id', user.id)
    .order('updated_at', { ascending: false });
  const { data } = await (c.req.query('all') === 'true'
    ? query
    : query.eq('reusable', true)
  ).returns<FullTemplateRow[]>();

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
 * Create a template from a PDF alone — no folder, no document.
 *
 * This is the "Nouveau template" flow: name it ("Devis"), upload the PDF it
 * describes, then place the zones. The PDF is kept with the template so the
 * editor and the annotated export never need to hunt for a document using it.
 */
templateRoutes.post('/upload', async (c) => {
  const user = c.get('user');
  const body = await c.req.parseBody();

  const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
  if (!name) throw badRequest('Donnez un nom à ce template.');
  // Which capture-sheet box signs it, when the operator said so up front.
  const sheetField =
    typeof body['sheetField'] === 'string' && body['sheetField'].trim()
      ? body['sheetField'].trim().slice(0, 64)
      : null;

  const file = body['file'] ?? body['files'];
  if (!(typeof file === 'object' && file !== null && 'arrayBuffer' in file)) {
    throw badRequest('Ajoutez le PDF que ce template décrit.', 'UPLOAD_FAILED');
  }
  const upload = file as File;
  if (upload.size > env.MAX_PDF_BYTES) {
    throw payloadTooLarge(
      `${upload.name} dépasse ${Math.round(env.MAX_PDF_BYTES / 1024 / 1024)} Mo.`,
    );
  }

  const bytes = new Uint8Array(await upload.arrayBuffer());
  if (!looksLikePdf(bytes)) throw unsupportedMedia(`${upload.name} n'est pas un PDF.`);
  const info = await inspectPdf(bytes);

  const { data, error } = await db
    .from('templates')
    .insert({
      owner_id: user.id,
      name,
      document_hash: sha256(bytes),
      page_count: info.pageCount,
      source_filename: upload.name,
      reusable: true,
      sheet_field: sheetField,
    })
    .select('*')
    .single<FullTemplateRow>();
  if (error || !data) {
    // A duplicate hash means a reusable template already describes this exact
    // file; two would make matching ambiguous.
    const duplicate = /duplicate key/i.test(error?.message ?? '');
    throw badRequest(
      duplicate
        ? 'Un template existe déjà pour ce document. Ouvrez-le plutôt que d’en créer un second.'
        : (error?.message ?? 'Création impossible.'),
      duplicate ? 'ALREADY_EXISTS' : 'INTERNAL_ERROR',
    );
  }

  const path = templateSourcePdfPath(user.id, data.id);
  await uploadObject(path, bytes, 'application/pdf');
  const { data: withSource } = await db
    .from('templates')
    .update({ source_pdf_path: path })
    .eq('id', data.id)
    .select('*')
    .single<FullTemplateRow>();

  await audit({
    ownerId: user.id,
    action: 'template.created',
    metadata: { templateId: data.id, name, pages: info.pageCount, standalone: true },
  });

  return c.json(toModel(withSource!, []), 201);
});

/** A short-lived link to the PDF a template was configured against. */
templateRoutes.get('/:id/source-url', async (c) => {
  const user = c.get('user');
  const template = await load(c.req.param('id'), user.id);
  if (template.source_pdf_path) {
    return c.json({
      url: await signedUrl(template.source_pdf_path),
      filename: template.source_filename ?? `${template.name}.pdf`,
      pageCount: template.page_count,
    });
  }

  // Older templates were configured against a document in a folder.
  const { data } = await db
    .from('documents')
    .select('storage_path, filename, page_count')
    .eq('owner_id', user.id)
    .eq('template_id', template.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ storage_path: string; filename: string; page_count: number }>();
  if (!data) throw notFound('Aucun PDF associé à ce template.');

  return c.json({
    url: await signedUrl(data.storage_path),
    filename: data.filename,
    pageCount: data.page_count,
  });
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

/**
 * Download the template as an annotated PDF: the document it describes, with
 * every zone drawn where the signature and stamp will actually land.
 *
 * It reuses the generator's own coordinate conversion, so this really is a
 * preview of what signing will do rather than a lookalike drawn twice.
 */
templateRoutes.get('/:id/export', async (c) => {
  const user = c.get('user');
  const template = await load(c.req.param('id'), user.id);

  // Prefer the template's own PDF; fall back to a document using it, which is
  // how templates created before this existed still work.
  let sourcePath = template.source_pdf_path;
  let sourceName = template.source_filename;
  if (!sourcePath) {
    const { data: document } = await db
      .from('documents')
      .select('filename, storage_path')
      .eq('owner_id', user.id)
      .eq('template_id', template.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{ filename: string; storage_path: string }>();
    if (!document) {
      throw notFound(
        'Aucun PDF associé à ce template : ni document source, ni document l’utilisant.',
      );
    }
    sourcePath = document.storage_path;
    sourceName = document.filename;
  }

  const zones = await loadTemplateZones(template.id);
  const original = await downloadObject(sourcePath);

  // Number each kind independently: "SIGNATURE 1, TAMPON 1" reads far better
  // than the global zone index, which would call the first stamp "TAMPON 4".
  // Seeded from the list itself, so a type added later cannot be missed here.
  const counters: Record<ZoneType, number> = Object.fromEntries(
    ZONE_TYPE.map((t) => [t, 0]),
  ) as Record<ZoneType, number>;
  const annotated = await annotateTemplate({
    pdfBytes: original,
    templateName: template.name,
    zones: zones.map((zone) => {
      counters[zone.type] += 1;
      const total = zones.filter((z) => z.type === zone.type).length;
      const name = ZONE_TYPE_LABEL[zone.type].toUpperCase();
      return {
        page: zone.page,
        type: zone.type,
        rect: { x: zone.x, y: zone.y, width: zone.width, height: zone.height },
        label: total > 1 ? `${name} ${counters[zone.type]}` : name,
      };
    }),
  });

  await audit({
    ownerId: user.id,
    action: 'template.exported',
    metadata: { templateId: template.id, zones: zones.length, document: sourceName },
  });

  const filename = `template-${template.name.replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase()}.pdf`;

  return c.body(annotated as unknown as ArrayBuffer, 200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': String(annotated.byteLength),
  });
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
      reusable: parsed.data.reusable,
      sheet_field: parsed.data.sheetField ?? null,
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
      reusable: parsed.data.reusable,
      sheet_field: parsed.data.sheetField ?? null,
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
