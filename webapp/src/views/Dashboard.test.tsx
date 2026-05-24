import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Dashboard } from './Dashboard';
import { ToastProvider } from '../toast';
import { ConfirmProvider } from '../confirm';
import type { CurrentState, HealthResponse, SelfState } from '../types';

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
    tag: 'v2.24.0',
    digest: 'sha256:abcdef123456',
    state: 'running',
    startedAt: new Date().toISOString(),
  },
  updaterServer: {
    tag: 'v0.5.3',
    digest: 'sha256:fedcba654321',
    state: 'running',
    updateAvailable: false,
  },
  doctorServer: { tag: 'v0.3.0', digest: 'sha256:111222333444', state: 'stopped' },
  lastCheck: new Date().toISOString(),
};

const sampleHealth: HealthResponse = {
  ok: true,
  runtime: 'podman',
  uptimeSeconds: 1234,
  version: '0.5.3',
};

const sampleSelf: SelfState = {
  currentTag: 'v0.5.3',
  updateAvailable: false,
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

  it('displays the current tag for each container', async () => {
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('v2.24.0')).toBeInTheDocument();
      expect(screen.getByText('v0.5.3')).toBeInTheDocument();
      expect(screen.getByText('v0.3.0')).toBeInTheDocument();
    });
  });

  it('disables the self-update button when up to date', async () => {
    renderDashboard();
    const btn = await screen.findByRole('button', { name: /self-update/i });
    expect(btn).toBeDisabled();
  });
});
