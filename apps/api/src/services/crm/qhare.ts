import { env } from '../../env.js';

/**
 * The Qhare connector — the CRM the operator's clients live in.
 *
 * Qhare (crm-qhare.fr) exposes an API and webhooks, but its documentation is
 * handed out per account, not published. So this module is built the way a
 * connector to an undocumented API has to be: the transport is configurable,
 * the response is read defensively, and everything degrades to "not
 * configured" rather than to an error the console has to explain.
 *
 * Configuration (all optional; without QHARE_API_URL and QHARE_API_KEY the
 * search reports itself unconfigured and the console says so):
 *
 *   QHARE_API_URL      base URL of the tenant's API, e.g. https://api.crm-qhare.fr
 *   QHARE_API_KEY      the tenant's API key
 *   QHARE_AUTH_HEADER  how the key travels: "bearer" (default) → Authorization:
 *                      Bearer <key>; anything else is used as a header name,
 *                      e.g. "X-API-Key"
 *   QHARE_SEARCH_PATH  path + query with a {q} placeholder for the search
 *                      term. Default "/contacts?search={q}". Adjust to the
 *                      documented endpoint once known.
 *
 * Fields are read from the usual names a CRM uses (name / nom, firstName /
 * prenom, lastName / nom, email, phone / telephone, city / ville, id). When
 * the documentation arrives, tighten `toClient` to its exact shape.
 */

export interface CrmClient {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  /** The CRM's own record, for whoever needs a field we did not map. */
  raw?: Record<string, unknown>;
}

export const qhareConfigured = (): boolean =>
  Boolean(env.QHARE_API_URL && env.QHARE_API_KEY);

const pick = (o: Record<string, unknown>, keys: string[]): string | null => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
};

const toClient = (o: Record<string, unknown>, index: number): CrmClient | null => {
  const first = pick(o, ['firstName', 'firstname', 'prenom', 'prénom', 'first_name']);
  const last = pick(o, ['lastName', 'lastname', 'nom', 'last_name']);
  const full =
    pick(o, ['name', 'fullName', 'displayName', 'raison_sociale', 'company', 'societe']) ??
    [first, last].filter(Boolean).join(' ');
  if (!full) return null;
  return {
    id: pick(o, ['id', 'uuid', '_id', 'reference', 'ref']) ?? `qhare-${index}`,
    name: full,
    email: pick(o, ['email', 'mail', 'courriel']),
    phone: pick(o, ['phone', 'telephone', 'téléphone', 'mobile', 'tel']),
    city: pick(o, ['city', 'ville', 'commune']),
    raw: o,
  };
};

/** Pull the array of records out of whatever envelope the API uses. */
const records = (body: unknown): Record<string, unknown>[] => {
  if (Array.isArray(body)) return body.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
  if (body && typeof body === 'object') {
    for (const key of ['data', 'items', 'results', 'contacts', 'clients', 'records', 'hydra:member']) {
      const v = (body as Record<string, unknown>)[key];
      if (Array.isArray(v)) return records(v);
    }
  }
  return [];
};

export const searchQhareClients = async (query: string, limit = 8): Promise<CrmClient[]> => {
  if (!qhareConfigured() || query.trim().length < 2) return [];
  const base = env.QHARE_API_URL!.replace(/\/+$/, '');
  const path = (env.QHARE_SEARCH_PATH ?? '/contacts?search={q}').replace('{q}', encodeURIComponent(query.trim()));
  const headers: Record<string, string> = { Accept: 'application/json' };
  const mode = env.QHARE_AUTH_HEADER ?? 'bearer';
  if (mode.toLowerCase() === 'bearer') headers['Authorization'] = `Bearer ${env.QHARE_API_KEY}`;
  else headers[mode] = env.QHARE_API_KEY!;

  const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(6_000) });
  if (!res.ok) throw new Error(`Qhare a répondu ${res.status}`);
  const body: unknown = await res.json();
  return records(body)
    .map(toClient)
    .filter((c): c is CrmClient => c !== null)
    .slice(0, limit);
};
