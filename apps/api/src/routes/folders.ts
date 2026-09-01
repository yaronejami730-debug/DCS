import { Hono } from 'hono';
import { createFolderSchema, importDocumentsSchema, type DocumentStatus } from '@scansign/shared';
import { db } from '../lib/supabase.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireAuth, type AppBindings } from '../lib/auth.js';
import { signedUrl } from '../lib/storage.js';
import { audit } from '../lib/audit.js';
import { zonesForDocument } from '../services/placement.js';
import {
  importPdfsIntoFolder,
  readPdfUploads,
  reopenFolderIfFinished,
} from '../services/documents.js';
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

/** List folders for the signed-in account. */
folderRoutes.get('/', async (c) => {
  const user = c.get('user');
  let query = db
    .from('folders')
    .select(FOLDER_SELECT)
    .eq('owner_id', user.id)
    .order('created_at', { ascending: false });


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

/**
 * Everything the console needs to line the folder's signatures up side by side.
 *
 * The question this answers is one you can only settle by looking: are these
 * five documents carrying five signings of the same hand, or the same bitmap
 * stamped five times? Variation is deliberate — a folder signed by hand does
 * not repeat itself — but "deliberate" is worth nothing if nobody can check it.
 *
 * Returns, per signed document, a short-lived link to its signed PDF and the
 * zones in force on it. The rendering and cropping happen in the browser, which
 * already has pdf.js loaded for the zone editor: sending page images from here
 * would mean a PDF renderer on the server for a screen nobody looks at twice.
 */
folderRoutes.get('/:id/comparison', async (c) => {
  const user = c.get('user');
  const folder = await loadFolder(c.req.param('id'), user.id);

  interface ComparisonRow {
    id: string;
    filename: string;
    status: DocumentStatus;
    storage_path: string;
    final_pdf_path: string | null;
    template_id: string | null;
    position: number;
    page_count: number;
    variant_index?: number | null;
  }

  const BASE_COLUMNS =
    'id, filename, status, storage_path, final_pdf_path, template_id, position, page_count';

  // `variant_index` only exists once the placement migration has run, and
  // PostgREST rejects the whole query for one unknown column. Ask for it, fall
  // back without it — the screen is more useful with the recorded variant, and
  // still useful without.
  let documents: ComparisonRow[] | null = null;
  const withVariant = await db
    .from('documents')
    .select(`${BASE_COLUMNS}, variant_index`)
    .eq('folder_id', folder.id)
    .order('position', { ascending: true })
    .returns<ComparisonRow[]>();

  if (withVariant.error) {
    const plain = await db
      .from('documents')
      .select(BASE_COLUMNS)
      .eq('folder_id', folder.id)
      .order('position', { ascending: true })
      .returns<ComparisonRow[]>();
    documents = plain.data;
  } else {
    documents = withVariant.data;
  }

  const items = [];
  for (const [ordinal, doc] of (documents ?? []).entries()) {
    const isSigned = doc.status === 'completed' && Boolean(doc.final_pdf_path);
    // An unsigned document still gets its original, so its column shows the
    // document rather than an apology. Which version is on screen is stated,
    // because comparing a signed page against an unsigned one and not being
    // told would be worse than showing nothing.
    const path = isSigned ? doc.final_pdf_path! : doc.storage_path;
    const { zones } = await zonesForDocument(doc);

    items.push({
      documentId: doc.id,
      filename: doc.filename,
      signed: isSigned,
      pageCount: doc.page_count,
      /**
       * Which variant this document carries.
       *
       * The recorded value when there is one. Otherwise the document's rank in
       * the folder, which is exactly what the pipeline assigns — so a document
       * signed before the column existed still reports the variant it was
       * actually given.
       */
      variantIndex: doc.variant_index ?? ordinal,
      variantRecorded: doc.variant_index !== null && doc.variant_index !== undefined,
      url: await signedUrl(path),
      /**
       * The document before anything was stamped on it.
       *
       * The comparison screen subtracts this from the signed page to isolate
       * the mark. Without it the only way to find the signature in a rendered
       * page is to look for dark pixels, which also finds the printed caption
       * sitting in the same zone — and then the overlay frames itself on
       * "Signature et cachet du bénéficiaire" rather than on the signature.
       */
      originalUrl: await signedUrl(doc.storage_path),
      // Only meaningful on a signed document: on an unsigned one these are
      // where the marks WILL go, which is not what this screen is about.
      zones: isSigned ? zones : [],
    });
  }

  return c.json({ folderId: folder.id, items, total: items.length });
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
  const files = readPdfUploads(body);
  // Asked on every import, and defaulted to the harmless value: a capture sheet
  // filed as a contract merely waits for a template, whereas a contract filed
  // as a capture sheet is silently never signed.
  const parsedRole = importDocumentsSchema.safeParse({
    role: typeof body['role'] === 'string' ? body['role'] : undefined,
  });
  if (!parsedRole.success) throw badRequest('Type de document invalide.');

  await importPdfsIntoFolder({
    ownerId: user.id,
    folderId: folder.id,
    files,
    role: parsedRole.data.role,
  });
  await reopenFolderIfFinished(folder.id, folder.status);

  const refreshed = await loadFolder(folder.id, user.id);
  publish(user.id, { type: 'folder.updated', folderId: folder.id, status: refreshed.status });
  return c.json(toFolder(refreshed), 201);
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
