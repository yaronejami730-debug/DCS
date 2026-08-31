import { Hono } from 'hono';
import {
  ONLINE_WINDOW_MS,
  registerDeviceSchema,
  updateDeviceSchema,
  type Device,
} from '@scansign/shared';
import { db } from '../lib/supabase.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireAuth, type AppBindings } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { publish } from '../lib/realtime.js';

export const deviceRoutes = new Hono<AppBindings>();
deviceRoutes.use('*', requireAuth);

interface DeviceRow {
  id: string;
  owner_id: string;
  name: string;
  platform: Device['platform'];
  push_token: string | null;
  last_seen_at: string | null;
  created_at: string;
}

const toModel = (row: DeviceRow): Device => ({
  id: row.id,
  ownerId: row.owner_id,
  name: row.name,
  platform: row.platform,
  pushToken: row.push_token,
  lastSeenAt: row.last_seen_at,
  createdAt: row.created_at,
  online: row.last_seen_at !== null && Date.now() - Date.parse(row.last_seen_at) < ONLINE_WINDOW_MS,
});

deviceRoutes.get('/', async (c) => {
  const user = c.get('user');
  const { data } = await db
    .from('devices')
    .select('*')
    .eq('owner_id', user.id)
    .order('created_at', { ascending: true })
    .returns<DeviceRow[]>();
  return c.json({ items: (data ?? []).map(toModel), total: data?.length ?? 0 });
});

/**
 * Called by the app right after sign-in. Keyed on installationId so relaunching
 * the app updates the existing device instead of piling up duplicates.
 */
deviceRoutes.post('/register', async (c) => {
  const user = c.get('user');
  const parsed = registerDeviceSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest("Données d'appareil invalides.", 'BAD_REQUEST', parsed.error.issues);

  const payload = {
    owner_id: user.id,
    name: parsed.data.name,
    platform: parsed.data.platform,
    push_token: parsed.data.pushToken ?? null,
    installation_id: parsed.data.installationId,
    last_seen_at: new Date().toISOString(),
  };

  const { data, error } = await db
    .from('devices')
    .upsert(payload, { onConflict: 'owner_id,installation_id' })
    .select('*')
    .single<DeviceRow>();

  if (error || !data) throw badRequest(error?.message ?? "Enregistrement de l'appareil impossible.");

  publish(user.id, { type: 'device.updated', deviceId: data.id });
  await audit({
    ownerId: user.id,
    action: 'device.registered',
    metadata: { deviceId: data.id, name: data.name, platform: data.platform },
  });

  return c.json(toModel(data));
});

deviceRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const parsed = updateDeviceSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest('Données invalides.');

  const patch: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.pushToken !== undefined) patch.push_token = parsed.data.pushToken;
  if (Object.keys(patch).length === 0) throw badRequest('Rien à mettre à jour.');

  const { data } = await db
    .from('devices')
    .update(patch)
    .eq('id', c.req.param('id'))
    .eq('owner_id', user.id)
    .select('*')
    .maybeSingle<DeviceRow>();

  if (!data) throw notFound('Appareil introuvable.');
  return c.json(toModel(data));
});

/** Heartbeat. Drives the online/offline dot in the console. */
deviceRoutes.post('/:id/ping', async (c) => {
  const user = c.get('user');
  const { data } = await db
    .from('devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', c.req.param('id'))
    .eq('owner_id', user.id)
    .select('*')
    .maybeSingle<DeviceRow>();
  if (!data) throw notFound('Appareil introuvable.');
  return c.json(toModel(data));
});

deviceRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const { error } = await db
    .from('devices')
    .delete()
    .eq('id', c.req.param('id'))
    .eq('owner_id', user.id);
  if (error) throw badRequest(error.message);
  await audit({ ownerId: user.id, action: 'device.removed', metadata: { deviceId: c.req.param('id') } });
  return c.json({ ok: true });
});
