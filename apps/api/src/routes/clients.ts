import { Hono } from 'hono';
import { env } from '../env.js';
import { db } from '../lib/supabase.js';
import { requireAuth, type AppBindings } from '../lib/auth.js';
import { searchLeads, webhookTokenFor } from '../services/crm/leads.js';

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
      detail: [l.category, l.state].filter(Boolean).join(' · ') || null,
    })),
  ];
  return c.json({ items, crm });
});

/** The URL to paste into Qhare's webhook form, minted for this account. */
clientRoutes.get('/webhook', async (c) => {
  const user = c.get('user');
  const token = await webhookTokenFor(user.id);
  const base = env.API_PUBLIC_URL.replace(/\/+$/, '');
  return c.json({ url: `${base}/webhooks/qhare/${token}`, provider: 'qhare' });
});
