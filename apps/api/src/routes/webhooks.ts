import { Hono } from 'hono';
import { leadFromWebhook, ownerForWebhookToken, upsertLead } from '../services/crm/leads.js';
import { audit } from '../lib/audit.js';

/**
 * Where the CRM pushes to. Public — Qhare carries no account of ours — and
 * authenticated by the secret in the path, which maps to exactly one account.
 *
 * Always 200 on a body we could file and 202 on one we could not: a webhook
 * sender that sees errors retries, and retrying a body we cannot read helps
 * nobody. The unreadable body is kept in the audit log so the mapping can be
 * fixed from a real example.
 */
export const webhookRoutes = new Hono();

webhookRoutes.post('/qhare/:token', async (c) => {
  const ownerId = await ownerForWebhookToken(c.req.param('token'));
  if (!ownerId) return c.json({ error: 'Jeton inconnu.' }, 404);

  let body: unknown;
  const type = c.req.header('content-type') ?? '';
  try {
    body = type.includes('application/json') ? await c.req.json() : await c.req.parseBody();
  } catch {
    body = null;
  }
  // Form posts may carry the lead as a JSON string in one field.
  if (body && typeof body === 'object') {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (typeof v === 'string' && v.startsWith('{')) {
        try {
          (body as Record<string, unknown>)[k] = JSON.parse(v);
        } catch {
          /* plain string */
        }
      }
    }
  }

  const lead = leadFromWebhook(body);
  if (!lead) {
    await audit({
      ownerId,
      action: 'crm.webhook_unreadable',
      metadata: { provider: 'qhare', body: body ?? null },
    });
    return c.json({ ok: false, reason: 'lead non reconnu' }, 202);
  }

  await upsertLead(ownerId, lead.externalId, lead.fields, body);
  await audit({
    ownerId,
    action: 'crm.lead_received',
    metadata: { provider: 'qhare', externalId: lead.externalId, name: lead.fields.name },
  });
  return c.json({ ok: true });
});
