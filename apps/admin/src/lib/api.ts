import type { ApiError, AuthSession } from '@scansign/shared';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787';
const STORAGE_KEY = 'scansign.session';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export const loadSession = (): AuthSession | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthSession) : null;
  } catch {
    return null;
  }
};

export const saveSession = (session: AuthSession | null): void => {
  if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  else localStorage.removeItem(STORAGE_KEY);
};

let onSessionLost: (() => void) | null = null;
export const setSessionLostHandler = (fn: (() => void) | null): void => {
  onSessionLost = fn;
};

/** Refresh once, transparently, when the access token has aged out. */
const refresh = async (): Promise<AuthSession | null> => {
  const current = loadSession();
  if (!current) return null;
  const res = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: current.refreshToken }),
  });
  if (!res.ok) {
    saveSession(null);
    onSessionLost?.();
    return null;
  }
  const next = (await res.json()) as AuthSession;
  saveSession(next);
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

  const send = async (token: string | null): Promise<Response> =>
    fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : form,
    });

  let session = auth ? loadSession() : null;
  let res = await send(session?.accessToken ?? null);

  if (res.status === 401 && auth) {
    session = await refresh();
    if (session) res = await send(session.accessToken);
  }

  if (res.status === 204) return undefined as T;

  const body = (await res.json().catch(() => ({}))) as T & ApiError;
  if (!res.ok) {
    if (res.status === 401) {
      saveSession(null);
      onSessionLost?.();
    }
    throw new ApiRequestError(
      res.status,
      body.error ?? `Erreur ${res.status}`,
      body.code,
      body.details,
    );
  }
  return body;
};

export { API_URL };
