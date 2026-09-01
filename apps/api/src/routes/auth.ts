import { Hono } from 'hono';
import { loginSchema, refreshSchema, signupSchema, type AuthSession } from '@scansign/shared';
import { env } from '../env.js';
import { authClient, db } from '../lib/supabase.js';
import { HttpError, badRequest, forbidden, unauthorized } from '../lib/errors.js';
import { requireAuth, type AppBindings } from '../lib/auth.js';

export const authRoutes = new Hono<AppBindings>();

const toSession = (session: {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  user: { id: string; email?: string; user_metadata?: Record<string, unknown> };
}): AuthSession => ({
  accessToken: session.access_token,
  refreshToken: session.refresh_token,
  expiresAt: (session.expires_at ?? Math.floor(Date.now() / 1000) + 3600) * 1000,
  user: {
    id: session.user.id,
    email: session.user.email ?? '',
    displayName: (session.user.user_metadata?.display_name as string | undefined) ?? null,
  },
});

/**
 * The console's sign-in. Signers do not have accounts: they follow a link.
 * Both clients call this endpoint rather than talking to Supabase directly,
 * which is why neither bundle contains a Supabase key.
 */
authRoutes.post('/login', async (c) => {
  const body = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw badRequest('Email ou mot de passe invalide.', 'BAD_REQUEST');

  const { data, error } = await authClient.auth.signInWithPassword(body.data);
  if (error || !data.session) throw unauthorized('Identifiants incorrects.');

  return c.json(toSession(data.session));
});

authRoutes.post('/signup', async (c) => {
  if (!env.ALLOW_SELF_SIGNUP) {
    throw forbidden('La création de compte est désactivée sur cette instance.');
  }
  const body = signupSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    throw badRequest('Email invalide ou mot de passe trop court (8 caractères minimum).');
  }

  // With AUTO_CONFIRM_SIGNUP the backend creates the account through the admin
  // API already confirmed, so the same credentials work on the console and on
  // the console immediately. Without it we fall back to the normal Supabase flow
  // and the project's own email-confirmation setting applies.
  if (env.AUTO_CONFIRM_SIGNUP) {
    const { error } = await db.auth.admin.createUser({
      email: body.data.email,
      password: body.data.password,
      email_confirm: true,
      user_metadata: { display_name: body.data.displayName ?? null },
    });
    if (error) {
      const already = /registered|exists/i.test(error.message);
      throw new HttpError(
        already ? 409 : 400,
        already ? 'Un compte existe déjà avec cet email.' : error.message,
        already ? 'ALREADY_REGISTERED' : 'SIGNUP_FAILED',
      );
    }
    const { data: signedIn, error: signInError } = await authClient.auth.signInWithPassword({
      email: body.data.email,
      password: body.data.password,
    });
    if (signInError || !signedIn.session) throw unauthorized('Connexion impossible après création.');
    return c.json(toSession(signedIn.session), 201);
  }

  const { data, error } = await authClient.auth.signUp({
    email: body.data.email,
    password: body.data.password,
    options: { data: { display_name: body.data.displayName ?? null } },
  });
  if (error) throw new HttpError(400, error.message, 'SIGNUP_FAILED');
  if (!data.session) {
    throw new HttpError(
      202,
      'Compte créé. Confirmez votre email puis connectez-vous.',
      'CONFIRMATION_REQUIRED',
    );
  }
  return c.json(toSession(data.session), 201);
});

authRoutes.post('/refresh', async (c) => {
  const body = refreshSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw badRequest('Jeton de rafraîchissement manquant.');

  const { data, error } = await authClient.auth.refreshSession({
    refresh_token: body.data.refreshToken,
  });
  if (error || !data.session) throw unauthorized('Session expirée, reconnectez-vous.');
  return c.json(toSession(data.session));
});

authRoutes.get('/me', requireAuth, async (c) => {
  const user = c.get('user');
  const { count } = await db
    .from('devices')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', user.id);
  return c.json({ ...user, deviceCount: count ?? 0 });
});
