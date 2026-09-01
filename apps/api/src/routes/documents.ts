import { Hono, type Context } from 'hono';
import { ZONE_TYPE, adjustPlacementSchema, assignTemplateSchema } from '@scansign/shared';
import { annotateTemplate } from '@scansign/pdf';
import { ZONE_TYPE_LABEL, previewPdfPath, type ZoneType } from '@scansign/shared';
import { db } from '../lib/supabase.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import {
  assertShareScope,
  documentIdsForLink,
  requireAuthOrShare,
  type ShareBindings,
} from '../lib/share.js';
import { downloadObject, signedUrl, uploadObject } from '../lib/storage.js';
import { audit } from '../lib/audit.js';
import { publish } from '../lib/realtime.js';
import { loadTemplateZones } from '../services/templates.js';
import {
  adjustDocumentPlacement,
  adjustmentBlocker,
  resetDocumentPlacement,
  zonesForDocument,
} from '../services/placement.js';
import { toDocument, type DocumentRow } from './mappers.js';

export const documentRoutes = new Hono<ShareBindings>();

/**
 * Reachable by the console, and by an *operator* share link — the account
 * holder who scanned a QR code off their own screen to carry on from their
 * phone. A signer link is refused at `load` below: an outside technician has no
 * business reading a document, whatever route they try.
 */
documentRoutes.use('*', requireAuthOrShare);

/**
 * Reading a document through an operator link is fine — it is the owner on
 * their own phone. *Changing* one is not: re-assigning a template or moving a
 * placement rewrites how every future signature lands, and a link is a bearer
 * secret that can be screenshotted, forwarded or left in a browser on a shared
 * machine. Those decisions stay behind a real sign-in.
 */
documentRoutes.use('*', async (c, next) => {
  const method = c.req.method;
  if (method !== 'GET' && method !== 'HEAD' && c.get('share')) {
    throw forbidden('Cette action demande une connexion à la console.');
  }
  await next();
});

const SELECT = '*, templates:template_id (id, name)';

/**
 * Load a document, enforcing every half of the share rule in one place.
 *
 * Three checks, and all three are needed:
 *   owner_id     — whose document it is
 *   folder       — the folder the link names
 *   subset       — the documents that link actually covers
 *
 * The third is the one that is easy to forget and expensive to omit: without
 * it, a link scoped to the delivery notes would still serve the contract
 * sitting in the same folder. Every route in this file goes through here rather
 * than repeating them, because a check each handler has to remember is a check
 * one handler will eventually not.
 */
const load = async (
  c: Context<ShareBindings>,
  id: string,
  ownerId: string,
): Promise<DocumentRow> => {
  const share = c.get('share');

  const { data } = await db
    .from('documents')
    .select(SELECT)
    .eq('id', id)
    .eq('owner_id', ownerId)
    .maybeSingle<DocumentRow>();
  if (!data) throw notFound('Document introuvable.');

  assertShareScope(share, data.folder_id);

  if (share) {
    const allowed = await documentIdsForLink(share.linkId, share.folderId);
    if (!allowed.includes(data.id)) {
      throw forbidden('Ce lien ne donne pas accès à ce document.');
    }
  }
  return data;
};

documentRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  return c.json(toDocument(await load(c, c.req.param('id'), user.id)));
});

/** Short-lived link to the ORIGINAL PDF — used by the console's preview. */
documentRoutes.get('/:id/original-url', async (c) => {
  const user = c.get('user');
  const doc = await load(c, c.req.param('id'), user.id);
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
  const doc = await load(c, c.req.param('id'), user.id);

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
  // Seeded from the list itself, so a type added later cannot be missed here.
  const counters: Record<ZoneType, number> = Object.fromEntries(
    ZONE_TYPE.map((t) => [t, 0]),
  ) as Record<ZoneType, number>;
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
  const doc = await load(c, c.req.param('id'), user.id);
  if (!doc.final_pdf_path) throw notFound("Ce document n'a pas encore de version signée.");
  return c.json({
    url: await signedUrl(doc.final_pdf_path),
    filename: doc.filename.replace(/\.pdf$/i, '') + '-signe.pdf',
  });
});

/**
 * Where this document's marks currently sit.
 *
 * The console opens the adjustment editor with these, so what the operator
 * drags is what is actually stamped — the template's zones until someone has
 * adjusted this document, its own from then on.
 */
documentRoutes.get('/:id/placement', async (c) => {
  const user = c.get('user');
  const doc = await load(c, c.req.param('id'), user.id);
  const { zones, source } = await zonesForDocument(doc);

  return c.json({
    documentId: doc.id,
    source,
    zones,
    // Surfaced rather than inferred client-side: the reasons a signed document
    // cannot be re-stamped (no session recorded, cutouts purged by retention)
    // are server-side facts, and the console should say which one applies.
    blockedReason: adjustmentBlocker(doc),
  });
});

/**
 * Move or resize the marks on a signed document, and re-stamp it.
 *
 * Regenerates from the ORIGINAL PDF plus the stored cutout at its recorded
 * variant, so the signature is the same one — only its geometry changes. The
 * signed PDF keeps its path, so links already handed out still resolve.
 */
documentRoutes.post('/:id/placement', async (c) => {
  const user = c.get('user');
  const parsed = adjustPlacementSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw badRequest('Zones invalides.', 'BAD_REQUEST', parsed.error.issues);
  }

  const result = await adjustDocumentPlacement({
    documentId: c.req.param('id'),
    ownerId: user.id,
    zones: parsed.data.zones.map((zone) => ({
      page: zone.page,
      type: zone.type,
      rect: zone.rect,
      index: zone.index,
    })),
  });

  return c.json(result);
});

/** Drop this document's overrides and go back to the template's placement. */
documentRoutes.delete('/:id/placement', async (c) => {
  const user = c.get('user');
  return c.json(
    await resetDocumentPlacement({ documentId: c.req.param('id'), ownerId: user.id }),
  );
});

/**
 * Attach a template to a document that arrived unmatched. Also back-fills the
 * template's document_hash so the NEXT upload of the same file matches on hash
 * automatically — the system learns from the operator once.
 */
documentRoutes.post('/:id/template', async (c) => {
  const user = c.get('user');
  const doc = await load(c, c.req.param('id'), user.id);
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
