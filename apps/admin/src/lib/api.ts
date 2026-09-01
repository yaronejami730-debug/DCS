import type { ApiError, AuthSession } from '@scansign/shared';

/**
 * Where the backend is, from wherever the console was opened.
 *
 * `VITE_API_URL` names it, but its default — and its usual value — is
 * `localhost:8787`, which is correct only when the console is open on the
 * machine running the API. Open it from a phone or another laptop on the LAN,
 * via the machine's IP, and `localhost` becomes *that* device: every request,
 * the login included, dies at a connection refused with no useful error, and
 * the page just says "Connexion impossible".
 *
 * So when the page itself was not served from a loopback host but the
 * configured API is a loopback one, the page's own hostname is the better
 * guess. Same rule the signer app uses.
 */
const resolveApiUrl = (): string => {
  const configured = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '');
  const raw = configured || 'http://localhost:8787';

  if (typeof window === 'undefined') return raw;
  const here = window.location.hostname;
  const isLoopbackHere = here === 'localhost' || here === '127.0.0.1' || here === '[::1]';
  if (isLoopbackHere) return raw;

  try {
    const url = new URL(raw);
    const isLoopbackThere =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (!isLoopbackThere) return raw;
    url.hostname = here;
    // A page served over HTTPS cannot call a plain-HTTP API — the browser
    // blocks it as mixed content, silently. Follow the page's scheme.
    url.protocol = window.location.protocol;
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw;
  }
};

const API_URL = resolveApiUrl();
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

/**
 * Fetch a binary response (a PDF) with the same auth and refresh handling as
 * `api`, and hand it to the browser as a download.
 */
export const downloadFile = async (path: string, fallbackName: string): Promise<void> => {
  const send = async (token: string | null) =>
    fetch(`${API_URL}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  let session = loadSession();
  let res = await send(session?.accessToken ?? null);
  if (res.status === 401) {
    session = await refresh();
    if (session) res = await send(session.accessToken);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as ApiError;
    throw new ApiRequestError(res.status, body.error ?? `Erreur ${res.status}`, body.code);
  }

  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="?([^";]+)"?/.exec(disposition);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = match?.[1] ?? fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

export { API_URL };
