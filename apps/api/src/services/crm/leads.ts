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
  reference: string | null;
  address: string | null;
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
 * Qhare's webhook, as observed on a real delivery, is flat and uses: id, nom,
 * prenom, civilite, tel, email, adresse, code_postal, ville, departement,
 * categorie, etat, sous_etat, numdossier, raison_sociale (BtoB client),
 * nom_societe (the Qhare tenant — NOT the client), affectation, commentaires…
 * The person's name leads; the company is kept alongside. Returns null when
 * no id or no name can be found — a body we cannot file is logged, not
 * invented.
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
  // Qhare's CSV export names its columns in plain French ("N°", "Raison
  // sociale", "Téléphone fixe", "Sous Etat"…); the webhook uses API names.
  // Both are listed, lower-cased as the CSV reader hands them over.
  const externalId =
    first(o, ['id', 'n°', 'lead_id', 'leadId', 'uuid', 'identifiant', 'id lead', 'lead']) ??
    first(o, ['numdossier', 'numéro de dossier', 'numero de dossier', 'n° dossier']);
  const firstName = first(o, ['prenom', 'prénom', 'firstName', 'first_name', 'prénom client']);
  const lastName = first(o, ['nom', 'lastName', 'last_name', 'nom client', 'nom du client']);
  const company = first(o, ['raison_sociale', 'raison sociale', 'company']);
  const person = [firstName, lastName].filter(Boolean).join(' ');
  const name = person || company || first(o, ['name']);
  if (!externalId || !name) return null;
  const state = [first(o, ['etat', 'état', 'state']), first(o, ['sous_etat', 'sous etat', 'sous état'])]
    .filter(Boolean)
    .join(' · ');
  return {
    externalId,
    fields: {
      name,
      first_name: firstName,
      last_name: lastName,
      company,
      phone: first(o, ['tel', 'telephone', 'téléphone', 'phone', 'mobile', 'portable', 'telephone_fixe', 'téléphone fixe']),
      email: first(o, ['email', 'mail']),
      city: first(o, ['ville', 'city']),
      postal_code: first(o, ['code_postal', 'code postal', 'cp', 'postal_code', 'zip', 'departement', 'département']),
      category: first(o, ['categorie', 'catégorie', 'category']),
      // (état / sous-état handled above)
      state: state || null,
      reference: first(o, ['numdossier', 'numéro de dossier', 'numero de dossier', 'n° dossier', 'numero_dossier', 'dossier mpr', 'reference', 'ref']),
      address: first(o, ['adresse', 'address']),
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
    .select(
      'id, external_id, name, first_name, last_name, company, phone, email, city, postal_code, category, state, reference, address, updated_at',
    )
    .eq('owner_id', ownerId);
  for (const w of words) {
    const like = `%${w.replace(/[%_,()]/g, '')}%`;
    q = q.or(
      [
        'name',
        'first_name',
        'last_name',
        'company',
        'phone',
        'email',
        'city',
        'postal_code',
        'address',
        'reference',
        'external_id',
      ]
        .map((col) => `${col}.ilike.${like}`)
        .join(','),
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
