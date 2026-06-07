import { useEffect, useState } from 'react';
import { Alert, Badge, Container, Nav, NavItem, NavLink } from 'reactstrap';
import { Dashboard } from './views/Dashboard';
import { Versions } from './views/Versions';
import { Logs } from './views/Logs';
import { api } from './api';
import { loadSession } from './session';
import { useApi } from './hooks/useApi';
import { useThemeSync } from './hooks/useThemeSync';
import { useToast } from './toast';
import type { AvailableUpdates, HealthResponse, ImageState } from './types';

type Route = 'dashboard' | 'versions' | 'logs';

const ROUTES: { id: Route; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'versions', label: 'Versions' },
  { id: 'logs', label: 'Logs' },
];

function parseHash(hash: string): Route {
  const trimmed = hash.replace(/^#\/?/, '');
  return ROUTES.some((r) => r.id === trimmed) ? (trimmed as Route) : 'dashboard';
}

function useHashRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = (r: Route): void => {
    window.location.hash = `#/${r}`;
  };
  return [route, navigate];
}

export function App() {
  useThemeSync();
  const [route, navigate] = useHashRoute();
  const toast = useToast();
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  // Bootstrap session token once. /api/session is unauthenticated and
  // returns the bearer token the page needs for mutating endpoints.
  // The rest of the UI can render in read-only mode if it fails.
  useEffect(() => {
    void (async () => {
      const r = await loadSession();
      setSessionReady(true);
      if (!r.ok) {
        setSessionError(r.error);
        toast.show(`Session bootstrap failed: ${r.error}`, 'err', 6000);
      }
    })();
  }, [toast]);

  // Pull the engine's version + runtime for the brand chip. Polled
  // gently because they only change after a self-update or runtime
  // socket flip.
  const health = useApi<HealthResponse>((signal) => api('/api/health', { signal }), {
    intervalMs: 30000,
  });

  // App-level daily-check snapshot. The server runs the actual GHCR
  // poll every 24h; we re-fetch the cached struct every 5 min so a
  // mid-day refresh inside the engine surfaces here without a page
  // reload. The badge stays visible across views (Dashboard / Versions
  // / Logs) so a user not on the Dashboard tab still gets the notice.
  const updates = useApi<AvailableUpdates>((signal) => api('/api/updates/available', { signal }), {
    intervalMs: 5 * 60 * 1000,
  });
  const driftingDeps =
    updates.data?.signalkDeps?.packages.filter((p) => p.classification !== 'up-to-date').length ??
    0;
  // An engine earns the badge when its image has drifted (rolling tag
  // moved on GHCR, or a pulled image awaits a restart) — the
  // same-semver-rolling-tag case the semver `updateAvailable` can't see.
  const imageStateNeedsAttention = (info?: { imageState?: ImageState }): boolean =>
    info?.imageState === 'restart-required' ||
    info?.imageState === 'pull-available' ||
    info?.imageState === 'pull-and-restart';
  const driftingImages =
    (imageStateNeedsAttention(updates.data?.signalkServer) ? 1 : 0) +
    (imageStateNeedsAttention(updates.data?.updater) ? 1 : 0) +
    (imageStateNeedsAttention(updates.data?.doctor) ? 1 : 0);
  const pendingUpdates =
    (updates.data?.updater.updateAvailable ? 1 : 0) +
    (updates.data?.doctor.updateAvailable ? 1 : 0) +
    driftingImages +
    driftingDeps;

  return (
    <Container className="py-4">
      <div className="d-flex align-items-center mb-4">
        <img
          src={`${import.meta.env.BASE_URL}app-icon.svg`}
          alt=""
          width={40}
          height={40}
          className="me-3"
        />
        <h1 className="h3 mb-0">SignalK Updater</h1>
        <Badge color="secondary" className="ms-3" title="Engine container version">
          v{__APP_VERSION__}
        </Badge>
        {health.data && health.data.runtime !== 'unknown' ? (
          <Badge color="info" className="ms-2" title="Container runtime">
            {health.data.runtime}
          </Badge>
        ) : null}
        {pendingUpdates > 0 ? (
          <a
            href="#/dashboard"
            className="ms-auto text-decoration-none"
            onClick={(e) => {
              e.preventDefault();
              navigate('dashboard');
            }}
            title="Open Dashboard to apply"
          >
            <Badge color="warning" pill>
              {pendingUpdates === 1 ? '1 update available' : `${pendingUpdates} updates available`}
            </Badge>
          </a>
        ) : null}
      </div>

      {sessionReady && sessionError !== null ? (
        <Alert color="warning" className="mb-3">
          Bearer token unavailable ({sessionError}). The UI will work in read-only mode; lifecycle
          actions and version switches are disabled.
        </Alert>
      ) : null}

      <Nav tabs className="mb-3">
        {ROUTES.map((r) => (
          <NavItem key={r.id}>
            <NavLink
              href={`#/${r.id}`}
              active={route === r.id}
              onClick={(e) => {
                e.preventDefault();
                navigate(r.id);
              }}
            >
              {r.label}
            </NavLink>
          </NavItem>
        ))}
      </Nav>

      {route === 'dashboard' ? <Dashboard /> : null}
      {route === 'versions' ? <Versions /> : null}
      {route === 'logs' ? <Logs /> : null}
    </Container>
  );
}
