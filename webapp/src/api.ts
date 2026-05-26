// Auth-aware fetch wrapper.
//
// Token is loaded once at boot from /api/session (see session.ts) and
// then attached to every mutating call as both Authorization: Bearer
// and X-SK-Auth — the latter forces a CORS preflight so a same-origin
// drive-by from the SignalK admin UI on a different port can't POST
// through silently. Mirrors the pattern from the previous vanilla app.
//
// API base discovery: when this webapp is loaded standalone at :3003
// all API paths live at /api/*. When the signalk-updater plugin
// reverse-proxies us under /plugins/signalk-updater/console/, our same
// /api/* requests need to be prefixed so they go through the proxy
// (otherwise they bypass it and hit signalk-server's root, 404). The
// plugin injects <meta name="api-base" content="/plugins/signalk-updater/console">
// into our HTML; we read it once at module load and prefix every path.
// EventSource sites call getApiBase() directly since they don't go
// through api().

export interface ApiError extends Error {
  status?: number;
  body?: unknown;
}

let token: string | null = null;

/**
 * Read <meta name="api-base"> once. Empty / missing tag means the webapp
 * is running standalone and paths should not be prefixed. Trailing slash
 * is stripped so `${apiBase}/api/x` always produces exactly one slash
 * between segments. Exported for tests; production callers should use
 * getApiBase() which returns the module-load-time cached value.
 */
export function readApiBase(): string {
  if (typeof document === 'undefined') return '';
  const meta = document.querySelector('meta[name="api-base"]');
  const raw = meta?.getAttribute('content') ?? '';
  return raw.replace(/\/+$/, '');
}

const apiBase = readApiBase();

/**
 * Prefix for all /api/* requests. Empty string when standalone, e.g.
 * "/plugins/signalk-updater/console" when proxied by the plugin. Used
 * by api() internally and by EventSource sites that build URLs by hand.
 */
export function getApiBase(): string {
  return apiBase;
}

export function setToken(value: string | null): void {
  token = value;
}

export function getToken(): string | null {
  return token;
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers = new Headers();
  headers.set('Accept', 'application/json');
  const bodyInit = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  if (bodyInit !== undefined) headers.set('Content-Type', 'application/json');
  if (token !== null) {
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-SK-Auth', token);
  }
  const res = await fetch(`${apiBase}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: bodyInit,
    signal: opts.signal,
  });
  if (res.status === 204) return null as T;
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    const err: ApiError = Object.assign(new Error(msg), {
      status: res.status,
      body,
    });
    throw err;
  }
  return body as T;
}
