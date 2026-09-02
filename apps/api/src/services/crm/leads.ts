import { randomBytes } from 'node:crypto';
import { db } from '../../lib/supabase.js';

/**
 * The CRM mirror: leads Qhare pushed to us, and the search that reads them.
 * See migration 20260118 for why a mirror and not a live query.
 */

export interface CrmLeadRow {
  id: string;
  external_id: string;
  name: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  postal_code: string | null;
  category: string | null;
  state: string | null;
  updated_at: string;
}

const str = (v: unknown): string | null => {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number') return String(v);
  return null;
};

const first = (o: Record<string, unknown>, keys: string[]): string | null => {
  for (const k of keys) {
    const v = str(o[k]);
    if (v) return v;
  }
  return null;
};

/**
 * Read a lead out of a webhook body, whatever its envelope.
 *
 * Qhare's field names follow its API (nom, prenom, telephone, email, ville,
 * code_postal, categorie, etat, raison_sociale…); the lead may sit at the top
 * level or under `lead` / `data`. Returns null when no id or no name can be
 * found — a body we cannot file is logged, not invented.
 */
export const leadFromWebhook = (
  body: unknown,
): { externalId: string; fields: Omit<CrmLeadRow, 'id' | 'external_id' | 'updated_at'> } | null => {
  if (!body || typeof body !== 'object') return null;
  let o = body as Record<string, unknown>;
  for (const key of ['lead', 'data', 'payload', 'object']) {
    const inner = o[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      o = { ...o, ...(inner as Record<string, unknown>) };
    }
  }
  const externalId = first(o, ['id', 'lead_id', 'leadId', 'uuid', 'reference']);
  const firstName = first(o, ['prenom', 'prénom', 'firstName', 'first_name']);
  const lastName = first(o, ['nom', 'lastName', 'last_name', 'name']);
  const company = first(o, ['raison_sociale', 'company', 'societe', 'société']);
  const name = company ?? [firstName, lastName].filter(Boolean).join(' ');
  if (!externalId || !name) return null;
  return {
    externalId,
    fields: {
      name,
      first_name: firstName,
      last_name: lastName,
      company,
      phone: first(o, ['telephone', 'téléphone', 'phone', 'mobile', 'telephone_fixe']),
      email: first(o, ['email', 'mail']),
      city: first(o, ['ville', 'city']),
      postal_code: first(o, ['code_postal', 'postal_code', 'zip', 'departement']),
      category: first(o, ['categorie', 'catégorie', 'category']),
      state: first(o, ['etat', 'état', 'state', 'statut']),
    },
  };
};

export const upsertLead = async (
  ownerId: string,
  externalId: string,
  fields: Omit<CrmLeadRow, 'id' | 'external_id' | 'updated_at'>,
  payload: unknown,
): Promise<void> => {
  const { error } = await db.from('crm_leads').upsert(
    {
      owner_id: ownerId,
      provider: 'qhare',
      external_id: externalId,
      ...fields,
      payload: payload ?? {},
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'owner_id,provider,external_id' },
  );
  if (error) throw new Error(error.message);
};

/** Name, phone, e-mail, city, postal code: every word must match one of them. */
export const searchLeads = async (ownerId: string, query: string, limit = 8): Promise<CrmLeadRow[]> => {
  const words = query.trim().split(/\s+/).filter(Boolean).slice(0, 4);
  if (words.length === 0) return [];
  let q = db
    .from('crm_leads')
    .select('id, external_id, name, first_name, last_name, company, phone, email, city, postal_code, category, state, updated_at')
    .eq('owner_id', ownerId);
  for (const w of words) {
    const like = `%${w.replace(/[%_,()]/g, '')}%`;
    q = q.or(
      `name.ilike.${like},phone.ilike.${like},email.ilike.${like},city.ilike.${like},postal_code.ilike.${like},external_id.ilike.${like}`,
    );
  }
  const { data } = await q.order('updated_at', { ascending: false }).limit(limit).returns<CrmLeadRow[]>();
  return data ?? [];
};

/** The account's webhook token, minted on first use. */
export const webhookTokenFor = async (ownerId: string): Promise<string> => {
  const { data } = await db
    .from('profiles')
    .select('crm_webhook_token')
    .eq('id', ownerId)
    .maybeSingle<{ crm_webhook_token: string | null }>();
  if (data?.crm_webhook_token) return data.crm_webhook_token;
  const token = randomBytes(24).toString('base64url');
  const { error } = await db.from('profiles').update({ crm_webhook_token: token }).eq('id', ownerId);
  if (error) throw new Error(error.message);
  return token;
};

export const ownerForWebhookToken = async (token: string): Promise<string | null> => {
  if (!token || token.length < 16) return null;
  const { data } = await db
    .from('profiles')
    .select('id')
    .eq('crm_webhook_token', token)
    .maybeSingle<{ id: string }>();
  return data?.id ?? null;
};
