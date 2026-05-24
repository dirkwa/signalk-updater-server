import { useCallback, useEffect, useRef, useState } from 'react';

interface UseApiOptions {
  /** Auto-refresh interval in ms while the document is visible. 0 = no polling. */
  intervalMs?: number;
}

export interface UseApiResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Re-run the fetcher. Resolves with the new data or null on error. */
  refresh: () => Promise<T | null>;
}

/**
 * Lightweight data hook with optional polling.
 *
 * Polling is suspended whenever document.visibilityState !== 'visible'
 * so a backgrounded tab doesn't keep hitting the engine. The first
 * fetch runs immediately on mount, the polling timer kicks off after
 * that. Aborts in-flight requests on unmount.
 *
 * refresh() aborts any in-flight refresh before starting a new one,
 * so rapid clicks on a Refresh button can't stale-overwrite a newer
 * response with an older one that just happened to finish later.
 */
export function useApi<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  opts: UseApiOptions = {},
): UseApiResult<T> {
  const { intervalMs = 0 } = opts;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Keep fetcher in a ref so the polling effect doesn't restart every
  // render just because the caller passed an inline arrow function.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const refreshAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async (): Promise<T | null> => {
    refreshAbortRef.current?.abort();
    const ac = new AbortController();
    refreshAbortRef.current = ac;
    setLoading(true);
    try {
      const value = await fetcherRef.current(ac.signal);
      if (!mountedRef.current || ac.signal.aborted) return null;
      setData(value);
      setError(null);
      return value;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return null;
      if (!mountedRef.current) return null;
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      if (mountedRef.current && !ac.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    const ac = new AbortController();
    void (async () => {
      try {
        const value = await fetcherRef.current(ac.signal);
        if (!cancelled) {
          setData(value);
          setError(null);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
      mountedRef.current = false;
      refreshAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (intervalMs <= 0) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, refresh]);

  return { data, error, loading, refresh };
}
