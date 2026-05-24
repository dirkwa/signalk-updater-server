import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Versions } from './Versions';
import { ToastProvider } from '../toast';
import { ConfirmProvider } from '../confirm';
import type { CurrentState, VersionsResponse } from '../types';

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
      },
      {
        name: 'v2.23.1',
        channel: 'stable',
        digest: 'sha256:bbb222',
        pushedAt: '2026-05-15T00:00:00Z',
      },
    ],
    beta: [],
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
    mockFetch({ '/api/versions': sampleVersions, '/api/state': sampleState });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('renders the populated stable channel and skips empty channels', async () => {
    renderVersions();
    expect(await screen.findByText('stable')).toBeInTheDocument();
    expect(screen.queryByText('beta')).not.toBeInTheDocument();
    expect(screen.queryByText('master')).not.toBeInTheDocument();
  });

  it('marks the current tag as "in use" and disables its Switch button', async () => {
    renderVersions();
    await screen.findByText('stable');
    // Wait for the state fetch to populate the current-tag badge.
    await waitFor(() => {
      expect(screen.getByText('current')).toBeInTheDocument();
    });
    const inUseBtn = screen.getByRole('button', { name: /in use/i });
    expect(inUseBtn).toBeDisabled();
  });

  it('lists older tags with a Switch button enabled', async () => {
    renderVersions();
    await screen.findByText('v2.23.1');
    const switchBtns = screen.getAllByRole('button', { name: /^switch$/i });
    expect(switchBtns.length).toBeGreaterThanOrEqual(1);
    expect(switchBtns[0]).not.toBeDisabled();
  });
});
