import { api, setToken } from './api';

interface SessionResponse {
  token?: string;
  error?: string;
}

/**
 * Fetch the bearer token from /api/session and stash it in the api
 * module so subsequent calls authenticate. Returns the error message
 * on failure so the UI can surface it via a toast — never throws.
 *
 * The token endpoint is read-only and unauthenticated by design; a
 * failure here means the token file isn't readable inside the engine
 * container (mount problem, mode bits). The UI can still render in
 * read-only mode (state/version/health all work without a token).
 */
export async function loadSession(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const s = await api<SessionResponse>('/api/session');
    if (s.token) {
      setToken(s.token);
      return { ok: true };
    }
    return { ok: false, error: s.error ?? 'no token in session response' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
