import { Hono } from 'hono';
import { FOLDER_STATUS, type DashboardInsights, type DashboardStats, type DocumentStatus, type FolderStatus } from '@scansign/shared';
import { env } from '../env.js';
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

/**
 * remove.bg credits, asked of remove.bg itself and remembered for a minute.
 *
 * The account endpoint is metered too (lightly), and the dashboard polls; a
 * short cache keeps the tile live without turning the tile into a cost. Null
 * when there is no key or the call fails: the tile says "indisponible", the
 * rest of the dashboard is unaffected.
 */
let removeBgCache: { at: number; value: DashboardInsights['removeBg'] } | null = null;
const removeBgCredits = async (): Promise<DashboardInsights['removeBg']> => {
  if (!env.REMOVEBG_API_KEY) return null;
  if (removeBgCache && Date.now() - removeBgCache.at < 60_000) return removeBgCache.value;
  try {
    const res = await fetch('https://api.remove.bg/v1.0/account', {
      headers: { 'X-Api-Key': env.REMOVEBG_API_KEY },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: { attributes?: { credits?: { total?: number; subscription?: number; payg?: number }; api?: { free_calls?: number } } };
    };
    const a = body.data?.attributes;
    const value = {
      total: a?.credits?.total ?? 0,
      subscription: a?.credits?.subscription ?? 0,
      payg: a?.credits?.payg ?? 0,
      freeCalls: a?.api?.free_calls ?? 0,
    };
    removeBgCache = { at: Date.now(), value };
    return value;
  } catch {
    removeBgCache = { at: Date.now(), value: null };
    return null;
  }
};

const DAYS = 14;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** Trends and account health — the row under the four tiles. */
dashboardRoutes.get('/insights', async (c) => {
  const user = c.get('user');
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const [signedRows, folderRows, templates, returns, removeBg] = await Promise.all([
    db
      .from('documents')
      .select('created_at, signing_sessions:signing_session_id (completed_at)')
      .eq('owner_id', user.id)
      .eq('status', 'completed')
      .limit(2000)
      .returns<Array<{ created_at: string; signing_sessions: { completed_at: string | null } | null }>>(),
    db.from('folders').select('status').eq('owner_id', user.id).returns<Array<{ status: FolderStatus }>>(),
    db.from('templates').select('id', { count: 'exact', head: true }).eq('owner_id', user.id).eq('reusable', true),
    db
      .from('share_link_returns')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', user.id)
      .is('handled_at', null),
    removeBgCredits(),
  ]);

  const perDay = new Map<string, number>();
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    perDay.set(dayKey(d), 0);
  }
  let signedLast7 = 0;
  let signedLast30 = 0;
  const now = Date.now();
  for (const row of signedRows.data ?? []) {
    const when = new Date(row.signing_sessions?.completed_at ?? row.created_at);
    const age = (now - when.getTime()) / 86_400_000;
    if (age <= 30) signedLast30 += 1;
    if (age <= 7) signedLast7 += 1;
    const key = dayKey(when);
    if (perDay.has(key)) perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }

  const foldersByStatus = Object.fromEntries(FOLDER_STATUS.map((s) => [s, 0])) as Record<FolderStatus, number>;
  for (const row of folderRows.data ?? []) foldersByStatus[row.status] = (foldersByStatus[row.status] ?? 0) + 1;

  const insights: DashboardInsights = {
    signedPerDay: Array.from(perDay, ([day, count]) => ({ day, count })),
    signedLast7,
    signedLast30,
    foldersByStatus,
    templates: templates.count ?? 0,
    pendingReturns: returns.count ?? 0,
    removeBg,
  };
  return c.json(insights);
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
