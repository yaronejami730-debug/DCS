import type { ApiError } from '@scansign/shared';

/**
 * The signing app talks to the API with one credential: the token in the URL.
 *
 * There is no account here and no session to refresh. Whoever opened the link
 * is authorised to photograph a signature into exactly one folder, for as long
 * as the link lives, and nothing else — the API enforces that, this file merely
 * carries the token.
 *
 * It travels as `Authorization: Share <token>` rather than a query parameter,
 * because tokens in URLs end up in access logs, `Referer` headers and browser
 * history. The one exception is the very first request, which has to name the
 * link in its path: at that point the page has nothing else to send.
 */

/**
 * Where the backend is, from wherever this page was opened.
 *
 * The console runs on the operator's own machine, so `localhost` is right for
 * it. This app is the opposite: its whole reason to exist is being opened on
 * someone else's phone, over the LAN or a tunnel, where `localhost` is that
 * phone — and every request dies at a connection refused with no useful error.
 *
 * So a configured URL wins, as always, unless it names a loopback host while
 * the page itself does not. In that one case the page's own hostname is
 * obviously the better guess, and the port is kept.
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
    // A page served over HTTPS cannot call a plain-HTTP API: the browser blocks
    // it as mixed content, silently. Follow the page's scheme.
    url.protocol = window.location.protocol;
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw;
  }
};

export const API_URL = resolveApiUrl();

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

/**
 * The active token.
 *
 * Module-level rather than React context because `api()` is called from query
 * functions that are not components. It is set from the route parameter on
 * every render of the flow, so a link opened in a second tab cannot leak its
 * token into the first — each tab has its own module instance.
 *
 * Deliberately NOT persisted. Nothing about this app should outlive the tab:
 * the technician is often on a shared or borrowed phone, and a token sitting in
 * localStorage after they hand it back is a signature waiting to be forged.
 */
let shareToken: string | null = null;

export const setShareToken = (token: string | null): void => {
  shareToken = token;
};

export const getShareToken = (): string | null => shareToken;

interface RequestOptions {
  method?: string;
  json?: unknown;
  form?: FormData;
  /** False for the public link-opening call, which carries no header. */
  auth?: boolean;
}

export const api = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  const { method = 'GET', json, form, auth = true } = options;

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(auth && shareToken ? { authorization: `Share ${shareToken}` } : {}),
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: json !== undefined ? JSON.stringify(json) : form,
  });

  if (res.status === 204) return undefined as T;

  const body = (await res.json().catch(() => ({}))) as T & ApiError;
  if (!res.ok) {
    throw new ApiRequestError(
      res.status,
      body.error ?? `Erreur ${res.status}`,
      body.code,
      body.details,
    );
  }
  return body;
};
