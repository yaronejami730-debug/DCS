import { Hono } from 'hono';
import { env } from '../env.js';
import { db } from '../lib/supabase.js';
import { requireAuth, type AppBindings } from '../lib/auth.js';
import { leadFromWebhook, searchLeads, upsertLead, webhookTokenFor, type CrmLeadRow } from '../services/crm/leads.js';
import { parseCsv } from '../services/crm/csv.js';
import { badRequest } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

export const clientRoutes = new Hono<AppBindings>();
clientRoutes.use('*', requireAuth);

export interface ClientSuggestion {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  source: 'qhare' | 'folder';
  /** For a 'folder' hit: the folder to open instead of creating one. */
  folderId?: string;
  /** For a 'qhare' hit: Qhare's own lead id, kept on the folder created from it. */
  crmLeadId?: string;
  detail?: string | null;
}

/**
 * What the search box offers as the operator types: the CRM leads mirrored
 * from Qhare's webhooks, and the folders already here whose name matches —
 * one list, so a client who already has a folder is opened, not duplicated.
 */
clientRoutes.get('/search', async (c) => {
  const user = c.get('user');
  const q = (c.req.query('q') ?? '').trim();
  const { count } = await db
    .from('crm_leads')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', user.id);
  const crm = { name: 'qhare', configured: (count ?? 0) > 0, leads: count ?? 0, error: null };
  if (q.length < 2) return c.json({ items: [], crm });

  const [{ data: folders }, leads] = await Promise.all([
    db
      .from('folders')
      .select('id, name')
      .eq('owner_id', user.id)
      .ilike('name', `%${q.replace(/[%_]/g, '')}%`)
      .order('created_at', { ascending: false })
      .limit(5)
      .returns<Array<{ id: string; name: string }>>(),
    searchLeads(user.id, q),
  ]);

  const items: ClientSuggestion[] = [
    ...(folders ?? []).map<ClientSuggestion>((f) => ({
      id: f.id,
      name: f.name,
      email: null,
      phone: null,
      city: null,
      source: 'folder',
      folderId: f.id,
    })),
    ...leads.map<ClientSuggestion>((l) => ({
      id: l.id,
      name: l.name,
      email: l.email,
      phone: l.phone,
      city: [l.postal_code, l.city].filter(Boolean).join(' ') || null,
      source: 'qhare',
      crmLeadId: l.external_id,
      detail:
        [l.company, l.reference ? `dossier ${l.reference}` : null, l.category, l.state]
          .filter(Boolean)
          .join(' · ') || null,
    })),
  ];
  return c.json({ items, crm });
});

/**
 * Import a CRM export (CSV) into the mirror — the one-time backfill, since the
 * CRM's API cannot list what it already holds. Rows are read with the same
 * aliases as the webhook, so an export whose columns match the API names
 * (nom, prenom, tel, email, ville, code_postal, categorie, etat, numdossier…)
 * lands without configuration. Re-importing is safe: same lead id, same row.
 */
clientRoutes.post('/import', async (c) => {
  const user = c.get('user');
  const body = await c.req.parseBody();
  const file = body['file'];
  if (!(typeof file === 'object' && file !== null && 'arrayBuffer' in file)) {
    throw badRequest('Ajoutez le fichier CSV exporté depuis Qhare.', 'UPLOAD_FAILED');
  }
  const rows = parseCsv(new Uint8Array(await (file as File).arrayBuffer()));
  if (rows.length === 0) throw badRequest('Le fichier CSV est vide ou son en-tête est illisible.');

  let imported = 0;
  const skipped: number[] = [];
  const columns = Object.keys(rows[0]!);
  for (const [i, row] of rows.entries()) {
    const lead = leadFromWebhook(row);
    if (!lead) {
      skipped.push(i + 2);
      continue;
    }
    await upsertLead(user.id, lead.externalId, lead.fields, row);
    imported += 1;
  }
  await audit({
    ownerId: user.id,
    action: 'crm.import',
    metadata: { provider: 'qhare', rows: rows.length, imported, skipped: skipped.length, columns },
  });
  return c.json({ rows: rows.length, imported, skipped: skipped.slice(0, 20), columns });
});

/**
 * The client base as a table: paginated, searchable with the same rule as the
 * search box, each row saying whether a folder already exists for it.
 */
clientRoutes.get('/', async (c) => {
  const user = c.get('user');
  const q = (c.req.query('q') ?? '').trim();
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0);

  let query = db
    .from('crm_leads')
    .select(
      'id, external_id, name, first_name, last_name, company, phone, email, city, postal_code, category, state, reference, address, updated_at',
      { count: 'exact' },
    )
    .eq('owner_id', user.id);
  for (const w of q.split(/\s+/).filter(Boolean).slice(0, 4)) {
    const like = `%${w.replace(/[%_,()]/g, '')}%`;
    query = query.or(
      ['name', 'first_name', 'last_name', 'company', 'phone', 'email', 'city', 'postal_code', 'address', 'reference', 'external_id']
        .map((col) => `${col}.ilike.${like}`)
        .join(','),
    );
  }
  const { data, count } = await query
    .order('name', { ascending: true })
    .range(offset, offset + limit - 1)
    .returns<CrmLeadRow[]>();
  const rows = data ?? [];

  // Which of these clients already have a folder.
  const ids = rows.map((r) => r.external_id);
  const { data: folders } = ids.length
    ? await db
        .from('folders')
        .select('id, crm_lead_id')
        .eq('owner_id', user.id)
        .in('crm_lead_id', ids)
        .returns<Array<{ id: string; crm_lead_id: string }>>()
    : { data: [] };
  const folderFor = new Map((folders ?? []).map((f) => [f.crm_lead_id, f.id]));

  return c.json({
    total: count ?? rows.length,
    items: rows.map((r) => ({
      id: r.id,
      externalId: r.external_id,
      name: r.name,
      company: r.company,
      phone: r.phone,
      email: r.email,
      address: r.address,
      city: r.city,
      postalCode: r.postal_code,
      category: r.category,
      state: r.state,
      reference: r.reference,
      updatedAt: r.updated_at,
      folderId: folderFor.get(r.external_id) ?? null,
    })),
  });
});

/** The URL to paste into Qhare's webhook form, minted for this account. */
clientRoutes.get('/webhook', async (c) => {
  const user = c.get('user');
  const token = await webhookTokenFor(user.id);
  const base = env.API_PUBLIC_URL.replace(/\/+$/, '');
  return c.json({ url: `${base}/webhooks/qhare/${token}`, provider: 'qhare' });
});
