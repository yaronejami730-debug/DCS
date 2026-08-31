import { Hono } from 'hono';
import { assignTemplateSchema } from '@scansign/shared';
import { annotateTemplate } from '@scansign/pdf';
import { ZONE_TYPE_LABEL, previewPdfPath, type ZoneType } from '@scansign/shared';
import { db } from '../lib/supabase.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireAuth, type AppBindings } from '../lib/auth.js';
import { downloadObject, signedUrl, uploadObject } from '../lib/storage.js';
import { audit } from '../lib/audit.js';
import { publish } from '../lib/realtime.js';
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

/**
 * The document as the signer should see it before signing: the original with
 * its template zones drawn on top, so they can confirm the signature and the
 * stamp will land in the right boxes before taking a photo.
 *
 * Falls back to the plain original when no template is attached yet, and says
 * so, rather than pretending there is nothing to place.
 */
documentRoutes.get('/:id/preview-url', async (c) => {
  const user = c.get('user');
  const doc = await load(c.req.param('id'), user.id);

  // Once signed, the zones have served their purpose: show the real thing,
  // with the actual signature, stamp and mention on it. Overlaying the
  // configuration boxes on a finished document would only obscure it.
  if (doc.status === 'completed' && doc.final_pdf_path) {
    return c.json({
      url: await signedUrl(doc.final_pdf_path),
      filename: doc.filename,
      annotated: false,
      signed: true,
      zones: { signature: 0, stamp: 0, mention: 0, signature_stamp: 0 },
    });
  }

  if (!doc.template_id) {
    return c.json({
      url: await signedUrl(doc.storage_path),
      filename: doc.filename,
      annotated: false,
      signed: false,
      zones: { signature: 0, stamp: 0, mention: 0 },
    });
  }

  const zones = await loadTemplateZones(doc.template_id);
  if (zones.length === 0) {
    return c.json({
      url: await signedUrl(doc.storage_path),
      filename: doc.filename,
      annotated: false,
      signed: false,
      zones: { signature: 0, stamp: 0, mention: 0 },
    });
  }

  // Regenerated on every request rather than cached: a template can be edited
  // at any moment, and showing a signer a stale preview of where their
  // signature will go would be worse than showing none.
  const original = await downloadObject(doc.storage_path);
  const counters: Record<ZoneType, number> = {
    signature: 0,
    stamp: 0,
    mention: 0,
    signature_stamp: 0,
  };
  const annotated = await annotateTemplate({
    pdfBytes: original,
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

  const path = previewPdfPath(user.id, doc.id);
  await uploadObject(path, annotated, 'application/pdf');

  return c.json({
    url: await signedUrl(path),
    filename: doc.filename,
    annotated: true,
    signed: false,
    zones: {
      signature: zones.filter((z) => z.type === 'signature').length,
      stamp: zones.filter((z) => z.type === 'stamp').length,
      mention: zones.filter((z) => z.type === 'mention').length,
      signature_stamp: zones.filter((z) => z.type === 'signature_stamp').length,
    },
  });
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

  publish(user.id, {
    type: 'document.updated',
    documentId: doc.id,
    folderId: doc.folder_id,
    status: 'ready',
  });
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
