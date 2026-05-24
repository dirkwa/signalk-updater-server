// Auth-aware fetch wrapper.
//
// Token is loaded once at boot from /api/session (see session.ts) and
// then attached to every mutating call as both Authorization: Bearer
// and X-SK-Auth — the latter forces a CORS preflight so a same-origin
// drive-by from the SignalK admin UI on a different port can't POST
// through silently. Mirrors the pattern from the previous vanilla app.

export interface ApiError extends Error {
  status?: number;
  body?: unknown;
}

let token: string | null = null;

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
  const res = await fetch(path, {
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
