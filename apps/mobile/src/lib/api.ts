import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import type { ApiError, AuthSession } from '@scansign/shared';

/**
 * The phone talks ONLY to the Scan&Sign backend — never to Supabase directly.
 * That is why this bundle contains no Supabase key of any kind.
 *
 * The URL comes from app.config.js, which loads the monorepo-root .env that
 * Expo would otherwise ignore. The EXPO_PUBLIC_ variable remains a fallback so
 * an EAS profile can override it directly.
 */
const configuredApiUrl = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;

export const API_URL = (
  configuredApiUrl ??
  process.env.EXPO_PUBLIC_API_URL ??
  'http://localhost:8787'
).replace(/\/$/, '');

const SESSION_KEY = 'scansign.session';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

let cachedSession: AuthSession | null = null;
let sessionLostHandler: (() => void) | null = null;

export const setSessionLostHandler = (fn: (() => void) | null): void => {
  sessionLostHandler = fn;
};

export const loadSession = async (): Promise<AuthSession | null> => {
  if (cachedSession) return cachedSession;
  try {
    const raw = await SecureStore.getItemAsync(SESSION_KEY);
    cachedSession = raw ? (JSON.parse(raw) as AuthSession) : null;
  } catch {
    cachedSession = null;
  }
  return cachedSession;
};

export const saveSession = async (session: AuthSession | null): Promise<void> => {
  cachedSession = session;
  if (session) await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
  else await SecureStore.deleteItemAsync(SESSION_KEY);
};

const refresh = async (): Promise<AuthSession | null> => {
  const current = await loadSession();
  if (!current) return null;
  const res = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: current.refreshToken }),
  });
  if (!res.ok) {
    await saveSession(null);
    sessionLostHandler?.();
    return null;
  }
  const next = (await res.json()) as AuthSession;
  await saveSession(next);
  return next;
};

interface RequestOptions {
  method?: string;
  json?: unknown;
  form?: FormData;
  auth?: boolean;
}

export const api = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  const { method = 'GET', json, form, auth = true } = options;

  const send = async (token: string | null) =>
    fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : form,
    });

  let session = auth ? await loadSession() : null;
  let res = await send(session?.accessToken ?? null);

  if (res.status === 401 && auth) {
    session = await refresh();
    if (session) res = await send(session.accessToken);
  }

  const body = (await res.json().catch(() => ({}))) as T & ApiError;
  if (!res.ok) {
    if (res.status === 401) {
      await saveSession(null);
      sessionLostHandler?.();
    }
    throw new ApiRequestError(res.status, body.error ?? `Erreur ${res.status}`, body.code);
  }
  return body;
};

/**
 * React Native's FormData accepts a {uri,name,type} descriptor for local files;
 * it streams the file without loading it into JS memory.
 */
export const fileFromUri = (uri: string, name: string, type: string): Blob =>
  ({ uri, name, type }) as unknown as Blob;
