import { useEffect } from 'react';

/**
 * Keep <html data-bs-theme> in sync with the OS color-scheme preference.
 *
 * The initial value is set by a tiny inline script in index.html (so the
 * very first paint is themed correctly without waiting for React). This
 * hook listens for runtime changes — e.g. the user flips their OS dark
 * mode toggle while the page is open — and flips Bootstrap's color
 * variables along with it.
 */
export function useThemeSync(): void {
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (matches: boolean): void => {
      document.documentElement.setAttribute('data-bs-theme', matches ? 'dark' : 'light');
    };
    apply(mql.matches);
    const listener = (e: MediaQueryListEvent): void => apply(e.matches);
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  }, []);
}
