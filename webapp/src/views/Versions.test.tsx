import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Versions } from './Versions';
import { ToastProvider } from '../toast';
import { ConfirmProvider } from '../confirm';
import type { CurrentState, VersionSettings, VersionsResponse } from '../types';

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

const sampleVersions: VersionsResponse = {
  cachedAt: new Date().toISOString(),
  channels: {
    stable: [
      {
        name: 'v2.24.0',
        channel: 'stable',
        digest: 'sha256:aaa111',
        pushedAt: '2026-05-20T00:00:00Z',
        isLocal: true,
      },
      {
        name: 'v2.23.1',
        channel: 'stable',
        digest: 'sha256:bbb222',
        pushedAt: '2026-05-15T00:00:00Z',
        isLocal: true,
      },
      {
        name: 'v2.22.0',
        channel: 'stable',
        digest: 'sha256:ccc333',
        pushedAt: '2026-05-01T00:00:00Z',
        isLocal: false,
      },
    ],
    beta: [
      {
        name: 'v2.25.0-beta.1',
        channel: 'beta',
        digest: 'sha256:beta1',
        pushedAt: '2026-05-21T00:00:00Z',
        isLocal: false,
      },
    ],
    master: [],
    dirkwa: [],
  },
};

const sampleState: CurrentState = {
  signalkServer: { tag: 'v2.24.0', digest: 'sha256:aaa111', state: 'running' },
  updaterServer: { tag: 'v0.5.3', digest: 'sha256:fed', state: 'running', updateAvailable: false },
  doctorServer: { tag: 'v0.3.0', digest: 'sha256:dca', state: 'stopped' },
  lastCheck: new Date().toISOString(),
};

const defaultSettings: VersionSettings = { showBeta: false, showMaster: false };

function renderVersions() {
  return render(
    <ToastProvider>
      <ConfirmProvider>
        <Versions />
      </ConfirmProvider>
    </ToastProvider>,
  );
}

describe('Versions', () => {
  beforeEach(() => {
    mockFetch({
      '/api/versions': sampleVersions,
      '/api/state': sampleState,
      '/api/versions/settings': defaultSettings,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('renders the populated stable channel and hides beta by default', async () => {
    renderVersions();
    expect(await screen.findByText('stable')).toBeInTheDocument();
    // beta has tags but the showBeta setting is false → channel card hidden.
    expect(screen.queryByText('beta')).not.toBeInTheDocument();
    expect(screen.queryByText('master')).not.toBeInTheDocument();
  });

  it('marks the current tag as in use', async () => {
    renderVersions();
    await screen.findByText('stable');
    await waitFor(() => {
      expect(screen.getByText('current')).toBeInTheDocument();
    });
    // The current row renders an "In use" span, not a button. Match the
    // exact action-cell text — "in use" appears in the channel
    // description ("recommended for boats in use") too.
    expect(await screen.findByText('In use')).toBeInTheDocument();
  });

  it('offers Switch on locally-cached non-current tags', async () => {
    renderVersions();
    await screen.findByText('v2.23.1');
    const switchBtns = await screen.findAllByRole('button', { name: /^switch$/i });
    expect(switchBtns.length).toBeGreaterThanOrEqual(1);
    expect(switchBtns[0]).not.toBeDisabled();
  });

  it('offers Pull on remote-only tags', async () => {
    renderVersions();
    await screen.findByText('v2.22.0');
    const pullBtns = await screen.findAllByRole('button', { name: /^pull$/i });
    expect(pullBtns.length).toBeGreaterThanOrEqual(1);
    expect(pullBtns[0]).not.toBeDisabled();
  });
});
