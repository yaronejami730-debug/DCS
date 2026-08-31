import { Hono } from 'hono';
import { ONLINE_WINDOW_MS, type DashboardStats, type DocumentStatus } from '@scansign/shared';
import { db } from '../lib/supabase.js';
import { requireAuth, type AppBindings } from '../lib/auth.js';
import { listNotifications } from '../services/notify.js';

export const dashboardRoutes = new Hono<AppBindings>();
dashboardRoutes.use('*', requireAuth);

const countDocuments = async (ownerId: string, statuses: DocumentStatus[]): Promise<number> => {
  const { count } = await db
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', ownerId)
    .in('status', statuses);
  return count ?? 0;
};

const countDevices = async (ownerId: string, onlineSince?: string): Promise<number> => {
  const query = db
    .from('devices')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', ownerId);
  const { count } = await (onlineSince ? query.gte('last_seen_at', onlineSince) : query);
  return count ?? 0;
};

dashboardRoutes.get('/', async (c) => {
  const user = c.get('user');
  const since = new Date(Date.now() - ONLINE_WINDOW_MS).toISOString();

  const [pendingDocuments, completedDocuments, errors, devicesTotal, devicesOnline] =
    await Promise.all([
      countDocuments(user.id, ['awaiting_template', 'ready', 'processing']),
      countDocuments(user.id, ['completed']),
      countDocuments(user.id, ['error']),
      countDevices(user.id),
      countDevices(user.id, since),
    ]);

  const stats: DashboardStats = {
    pendingDocuments,
    completedDocuments,
    errors,
    devicesTotal,
    devicesOnline,
  };
  return c.json(stats);
});

/** What the system has told this account, and whether it got through. */
dashboardRoutes.get('/notifications', async (c) => {
  const user = c.get('user');
  const items = await listNotifications(user.id);
  return c.json({ items, total: items.length });
});

/** Recent activity feed shown under the dashboard tiles. */
dashboardRoutes.get('/activity', async (c) => {
  const user = c.get('user');
  const { data } = await db
    .from('audit_logs')
    .select('id, action, metadata, created_at, folder_id, document_id')
    .eq('owner_id', user.id)
    .order('created_at', { ascending: false })
    .limit(30);
  return c.json({ items: data ?? [], total: data?.length ?? 0 });
});
