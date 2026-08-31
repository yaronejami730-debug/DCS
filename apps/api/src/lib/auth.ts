import type { Context, MiddlewareHandler } from 'hono';
import { db } from './supabase.js';
import { unauthorized } from './errors.js';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
}

export interface AppBindings {
  Variables: { user: AuthUser };
}

const readBearer = (c: Context): string | null => {
  const header = c.req.header('authorization') ?? c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
};

/**
 * Verifies a Supabase access token and pins the caller's identity onto the
 * request. The SAME token type is used by the web console and the iPhone —
 * one account, two clients.
 */
export const requireAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const token = readBearer(c);
  if (!token) throw unauthorized();

  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw unauthorized('Session expirée, reconnectez-vous.');

  const { data: profile } = await db
    .from('profiles')
    .select('display_name, email')
    .eq('id', data.user.id)
    .maybeSingle();

  c.set('user', {
    id: data.user.id,
    email: profile?.email ?? data.user.email ?? '',
    displayName: profile?.display_name ?? null,
  });

  await next();
};
