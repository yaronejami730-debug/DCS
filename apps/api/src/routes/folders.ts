import { Hono } from 'hono';
import {
  createFolderSchema,
  originalPdfPath,
  sendFolderSchema,
  type DocumentStatus,
} from '@scansign/shared';
import { inspectPdf, looksLikePdf, sha256 } from '@scansign/pdf';
import { env } from '../env.js';
import { db } from '../lib/supabase.js';
import { badRequest, notFound, payloadTooLarge, unsupportedMedia } from '../lib/errors.js';
import { requireAuth, type AppBindings } from '../lib/auth.js';
import { uploadObject } from '../lib/storage.js';
import { audit } from '../lib/audit.js';
import { findTemplateForDocument } from '../services/templates.js';
import { notifyFolderDelivered, notifyFolderSent } from '../services/notify.js';
import { publish } from '../lib/realtime.js';
import { FOLDER_SELECT, toFolder, type FolderRow } from './mappers.js';

export const folderRoutes = new Hono<AppBindings>();
folderRoutes.use('*', requireAuth);

const loadFolder = async (id: string, ownerId: string): Promise<FolderRow> => {
  const { data } = await db
    .from('folders')
    .select(FOLDER_SELECT)
    .eq('id', id)
    .eq('owner_id', ownerId)
    .maybeSingle<FolderRow>();
  if (!data) throw notFound('Dossier introuvable.');
  return data;
};

/**
 * List folders for the signed-in account.
 * The console calls it bare; the iPhone passes ?deviceId=… so it only sees what
 * was actually sent to it.
 */
folderRoutes.get('/', async (c) => {
  const user = c.get('user');
  let query = db
    .from('folders')
    .select(FOLDER_SELECT)
    .eq('owner_id', user.id)
    .order('created_at', { ascending: false });

  const deviceId = c.req.query('deviceId');
  if (deviceId) query = query.eq('device_id', deviceId);

  const status = c.req.query('status');
  if (status) query = query.in('status', status.split(','));

  const { data } = await query.returns<FolderRow[]>();
  const items = (data ?? []).map(toFolder);
  return c.json({ items, total: items.length });
});

folderRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  return c.json(toFolder(await loadFolder(c.req.param('id'), user.id)));
});

folderRoutes.post('/', async (c) => {
  const user = c.get('user');
  const parsed = createFolderSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest('Nom de dossier requis.');

  const { data, error } = await db
    .from('folders')
    .insert({
      owner_id: user.id,
      name: parsed.data.name,
      device_id: parsed.data.deviceId ?? null,
    })
    .select(FOLDER_SELECT)
    .single<FolderRow>();

  if (error || !data) throw badRequest(error?.message ?? 'Création impossible.');
  await audit({ ownerId: user.id, folderId: data.id, action: 'folder.created', metadata: { name: data.name } });
  return c.json(toFolder(data), 201);
});

/**
 * Upload one or more PDFs into a folder.
 *
 * For each file: size + magic-number check, SHA-256, page count, then template
 * matching (hash first, filename+page-count second). A document with no match
 * lands in `awaiting_template` and the console prompts the operator.
 */
folderRoutes.post('/:id/documents', async (c) => {
  const user = c.get('user');
  const folder = await loadFolder(c.req.param('id'), user.id);

  const body = await c.req.parseBody({ all: true });
  const raw = body['files'] ?? body['file'];
  const files = (Array.isArray(raw) ? raw : [raw]).filter(
    (f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f,
  );
  if (files.length === 0) throw badRequest('Aucun fichier reçu.', 'UPLOAD_FAILED');

  const { count: existing } = await db
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('folder_id', folder.id);

  const created: string[] = [];

  for (const [i, file] of files.entries()) {
    if (file.size > env.MAX_PDF_BYTES) {
      throw payloadTooLarge(
        `${file.name} dépasse la limite de ${Math.round(env.MAX_PDF_BYTES / 1024 / 1024)} Mo.`,
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!looksLikePdf(bytes)) {
      throw unsupportedMedia(`${file.name} n'est pas un PDF.`);
    }

    const info = await inspectPdf(bytes);
    const hash = sha256(bytes);
    const match = await findTemplateForDocument({
      ownerId: user.id,
      documentHash: hash,
      filename: file.name,
      pageCount: info.pageCount,
    });

    const status: DocumentStatus = match ? 'ready' : 'awaiting_template';

    const { data: doc, error } = await db
      .from('documents')
      .insert({
        folder_id: folder.id,
        owner_id: user.id,
        filename: file.name,
        storage_path: 'pending',
        document_hash: hash,
        page_count: info.pageCount,
        byte_size: bytes.byteLength,
        template_id: match?.template.id ?? null,
        status,
        position: (existing ?? 0) + i,
      })
      .select('id')
      .single<{ id: string }>();

    if (error || !doc) throw badRequest(error?.message ?? 'Import impossible.', 'UPLOAD_FAILED');

    const path = originalPdfPath(user.id, doc.id);
    await uploadObject(path, bytes, 'application/pdf');
    await db.from('documents').update({ storage_path: path }).eq('id', doc.id);

    created.push(doc.id);
    await audit({
      ownerId: user.id,
      folderId: folder.id,
      documentId: doc.id,
      action: 'document.imported',
      metadata: {
        filename: file.name,
        pages: info.pageCount,
        hash,
        template: match ? { id: match.template.id, matchedBy: match.matchedBy } : null,
      },
    });
  }

  // Adding a document to a folder that was already signed makes the folder
  // unfinished again: the new document has not been signed, and leaving the
  // badge on "Terminé" would claim work that has not happened.
  if (folder.status === 'completed' || folder.status === 'error') {
    await db
      .from('folders')
      .update({ status: 'pending', completed_at: null, error_code: null, error_message: null })
      .eq('id', folder.id);
  }

  const refreshed = await loadFolder(folder.id, user.id);
  publish(user.id, { type: 'folder.updated', folderId: folder.id, status: refreshed.status });
  return c.json(toFolder(refreshed), 201);
});

/** Assign the folder to a device and notify it. This is the "Envoyer" button. */
folderRoutes.post('/:id/send', async (c) => {
  const user = c.get('user');
  const folder = await loadFolder(c.req.param('id'), user.id);
  const parsed = sendFolderSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest('Appareil destinataire requis.');

  const { data: device } = await db
    .from('devices')
    .select('id, name')
    .eq('id', parsed.data.deviceId)
    .eq('owner_id', user.id)
    .maybeSingle<{ id: string; name: string }>();
  if (!device) throw notFound('Appareil introuvable.');

  if (!folder.documents || folder.documents.length === 0) {
    throw badRequest('Ajoutez au moins un document avant d’envoyer.', 'UPLOAD_FAILED');
  }
  const unconfigured = folder.documents.filter((d) => d.status === 'awaiting_template');
  if (unconfigured.length > 0) {
    throw badRequest(
      `${unconfigured.length} document(s) nécessitent une configuration de signature.`,
      'TEMPLATE_NOT_FOUND',
      { documents: unconfigured.map((d) => ({ id: d.id, filename: d.filename })) },
    );
  }

  const { data: updated } = await db
    .from('folders')
    .update({ device_id: device.id, status: 'pending', error_code: null, error_message: null })
    .eq('id', folder.id)
    .select(FOLDER_SELECT)
    .single<FolderRow>();

  await notifyFolderSent(user.id, folder.id, folder.documents?.length ?? 1);

  // Reaches every open client of this account: the phone shows the folder
  // without waiting for its poll, the console flips the badge at the same time.
  publish(user.id, {
    type: 'folder.sent',
    folderId: folder.id,
    deviceId: device.id,
    name: folder.name,
  });

  await audit({
    ownerId: user.id,
    folderId: folder.id,
    action: 'folder.sent',
    metadata: { deviceId: device.id, deviceName: device.name },
  });

  return c.json(toFolder(updated!));
});

/** The phone confirms reception. Turns the console badge from "En attente" to "Reçu". */
folderRoutes.post('/:id/ack', async (c) => {
  const user = c.get('user');
  const folder = await loadFolder(c.req.param('id'), user.id);
  if (folder.status !== 'pending') return c.json(toFolder(folder));

  const { data } = await db
    .from('folders')
    .update({ status: 'delivered', delivered_at: new Date().toISOString() })
    .eq('id', folder.id)
    .select(FOLDER_SELECT)
    .single<FolderRow>();

  await notifyFolderDelivered(user.id, folder.id);
  await audit({ ownerId: user.id, folderId: folder.id, action: 'folder.delivered' });
  return c.json(toFolder(data!));
});

folderRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const { error } = await db
    .from('folders')
    .delete()
    .eq('id', c.req.param('id'))
    .eq('owner_id', user.id);
  if (error) throw badRequest(error.message);
  publish(user.id, { type: 'folder.deleted', folderId: c.req.param('id') });
  return c.json({ ok: true });
});
