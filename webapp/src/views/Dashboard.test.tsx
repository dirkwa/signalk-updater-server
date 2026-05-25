import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Dashboard } from './Dashboard';
import { ToastProvider } from '../toast';
import { ConfirmProvider } from '../confirm';
import type {
  AvailableUpdates,
  CurrentState,
  DoctorState,
  HealthResponse,
  SelfState,
} from '../types';

// vi.restoreAllMocks() resets vi.fn spies but doesn't undo a direct
// globalThis.fetch assignment. Snapshot and restore by hand so a
// leaked mock can't bleed into a later test in the same file.
const originalFetch = globalThis.fetch;

function mockFetch(map: Record<string, unknown>): void {
  globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url, 'http://localhost').pathname;
    if (path in map) {
      return new Response(JSON.stringify(map[path]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'not mocked' }), { status: 404 });
  }) as typeof fetch;
}

const sampleState: CurrentState = {
  signalkServer: {
    tag: 'dirkwa',
    digest: 'sha256:abcdef123456',
    version: null,
    channel: 'dirkwa',
    state: 'running',
    startedAt: new Date().toISOString(),
  },
  updaterServer: {
    tag: 'latest',
    digest: 'sha256:fedcba654321',
    version: '0.6.4',
    channel: 'stable',
    state: 'running',
    updateAvailable: false,
  },
  doctorServer: {
    tag: 'latest',
    digest: 'sha256:111222333444',
    version: '0.3.0',
    channel: 'stable',
    state: 'stopped',
  },
  lastCheck: new Date().toISOString(),
};

const sampleHealth: HealthResponse = {
  ok: true,
  runtime: 'podman',
  uptimeSeconds: 1234,
  version: '0.6.4',
};

const sampleSelf: SelfState = {
  currentTag: '0.6.4',
  updateAvailable: false,
};

const sampleDoctor: DoctorState = {
  currentTag: '0.3.0',
  updateAvailable: false,
};

const sampleUpdates: AvailableUpdates = {
  updater: { currentTag: '0.6.4', updateAvailable: false },
  doctor: { currentTag: '0.3.0', updateAvailable: false },
  lastCheckedAt: new Date().toISOString(),
};

function renderDashboard() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <Dashboard />
      </ConfirmProvider>
    </ToastProvider>,
  );
}

describe('Dashboard', () => {
  beforeEach(() => {
    mockFetch({
      '/api/state': sampleState,
      '/api/health': sampleHealth,
      '/api/self/state': sampleSelf,
      '/api/doctor/state': sampleDoctor,
      '/api/updates/available': sampleUpdates,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('renders the three container cards', async () => {
    renderDashboard();
    expect(await screen.findByText('SignalK Server')).toBeInTheDocument();
    expect(await screen.findByText('Updater')).toBeInTheDocument();
    expect(await screen.findByText('Doctor')).toBeInTheDocument();
  });

  it('displays version and channel for each container', async () => {
    renderDashboard();
    await waitFor(() => {
      // Versions (semver from RuntimeIdentity)
      expect(screen.getByText('0.6.4')).toBeInTheDocument();
      expect(screen.getByText('0.3.0')).toBeInTheDocument();
      // Channels (OperatorIntent tag, rendered as `:tag` next to a badge)
      expect(screen.getAllByText(':latest').length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText(':dirkwa')).toBeInTheDocument();
    });
  });

  it('disables the self-update button when up to date', async () => {
    renderDashboard();
    const btn = await screen.findByRole('button', { name: /self-update/i });
    expect(btn).toBeDisabled();
  });
});
