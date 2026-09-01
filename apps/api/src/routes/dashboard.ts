import { Hono } from 'hono';
import type { DashboardStats, DocumentStatus } from '@scansign/shared';
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

/**
 * Share links that can still be used right now.
 *
 * The tile this feeds replaced "appareils en ligne". It answers the question an
 * operator actually has — how many signature requests are outstanding — where
 * the device count only ever answered how many phones had the app installed.
 */
const countActiveLinks = async (ownerId: string): Promise<number> => {
  const now = new Date().toISOString();
  const { count } = await db
    .from('folder_share_links')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', ownerId)
    .is('revoked_at', null)
    .or(`expires_at.is.null,expires_at.gt.${now}`);
  return count ?? 0;
};

dashboardRoutes.get('/', async (c) => {
  const user = c.get('user');

  const [pendingDocuments, completedDocuments, errors, activeLinks] = await Promise.all([
    countDocuments(user.id, ['awaiting_template', 'ready', 'processing']),
    countDocuments(user.id, ['completed']),
    countDocuments(user.id, ['error']),
    countActiveLinks(user.id),
  ]);

  const stats: DashboardStats = {
    pendingDocuments,
    completedDocuments,
    errors,
    activeLinks,
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
