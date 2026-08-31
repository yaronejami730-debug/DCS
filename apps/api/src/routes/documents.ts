import { Hono } from 'hono';
import { assignTemplateSchema } from '@scansign/shared';
import { db } from '../lib/supabase.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireAuth, type AppBindings } from '../lib/auth.js';
import { signedUrl } from '../lib/storage.js';
import { audit } from '../lib/audit.js';
import { loadTemplateZones } from '../services/templates.js';
import { toDocument, type DocumentRow } from './mappers.js';

export const documentRoutes = new Hono<AppBindings>();
documentRoutes.use('*', requireAuth);

const SELECT = '*, templates:template_id (id, name)';

const load = async (id: string, ownerId: string): Promise<DocumentRow> => {
  const { data } = await db
    .from('documents')
    .select(SELECT)
    .eq('id', id)
    .eq('owner_id', ownerId)
    .maybeSingle<DocumentRow>();
  if (!data) throw notFound('Document introuvable.');
  return data;
};

documentRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  return c.json(toDocument(await load(c.req.param('id'), user.id)));
});

/** Short-lived link to the ORIGINAL PDF — used by the phone's preview. */
documentRoutes.get('/:id/original-url', async (c) => {
  const user = c.get('user');
  const doc = await load(c.req.param('id'), user.id);
  return c.json({ url: await signedUrl(doc.storage_path), filename: doc.filename });
});

/** Short-lived link to the SIGNED PDF — the console's download button. */
documentRoutes.get('/:id/final-url', async (c) => {
  const user = c.get('user');
  const doc = await load(c.req.param('id'), user.id);
  if (!doc.final_pdf_path) throw notFound("Ce document n'a pas encore de version signée.");
  return c.json({
    url: await signedUrl(doc.final_pdf_path),
    filename: doc.filename.replace(/\.pdf$/i, '') + '-signe.pdf',
  });
});

/**
 * Attach a template to a document that arrived unmatched. Also back-fills the
 * template's document_hash so the NEXT upload of the same file matches on hash
 * automatically — the system learns from the operator once.
 */
documentRoutes.post('/:id/template', async (c) => {
  const user = c.get('user');
  const doc = await load(c.req.param('id'), user.id);
  const parsed = assignTemplateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest('Template requis.');

  const { data: template } = await db
    .from('templates')
    .select('id, document_hash, page_count')
    .eq('id', parsed.data.templateId)
    .eq('owner_id', user.id)
    .maybeSingle<{ id: string; document_hash: string | null; page_count: number | null }>();
  if (!template) throw notFound('Template introuvable.');

  const zones = await loadTemplateZones(template.id);
  if (zones.length === 0) {
    throw badRequest('Ce template ne contient aucune zone.', 'TEMPLATE_NOT_FOUND');
  }
  const overflow = zones.find((z) => z.page > doc.page_count);
  if (overflow) {
    throw badRequest(
      `Le template vise la page ${overflow.page}, or ce document en compte ${doc.page_count}.`,
      'TEMPLATE_ZONE_OUT_OF_RANGE',
    );
  }

  if (!template.document_hash) {
    await db
      .from('templates')
      .update({ document_hash: doc.document_hash, page_count: doc.page_count })
      .eq('id', template.id);
  }

  const { data } = await db
    .from('documents')
    .update({
      template_id: template.id,
      status: 'ready',
      error_code: null,
      error_message: null,
    })
    .eq('id', doc.id)
    .select(SELECT)
    .single<DocumentRow>();

  await audit({
    ownerId: user.id,
    folderId: doc.folder_id,
    documentId: doc.id,
    action: 'document.template_assigned',
    metadata: { templateId: template.id },
  });

  return c.json(toDocument(data!));
});

documentRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const { error } = await db
    .from('documents')
    .delete()
    .eq('id', c.req.param('id'))
    .eq('owner_id', user.id);
  if (error) throw badRequest(error.message);
  return c.json({ ok: true });
});
