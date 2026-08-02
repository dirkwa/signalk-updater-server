import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { Versions } from './Versions';
import { ToastProvider } from '../toast';
import { ConfirmProvider } from '../confirm';
import { StubEventSource } from '../../test-setup';
import type { AvailableUpdates, CurrentState, VersionSettings, VersionsResponse } from '../types';

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
  signalkServer: {
    tag: 'v2.24.0',
    digest: 'sha256:aaa111',
    state: 'running',
    version: '2.24.0',
    channel: 'stable',
  },
  updaterServer: {
    tag: 'v0.5.3',
    digest: 'sha256:fed',
    state: 'running',
    updateAvailable: false,
    version: '0.5.3',
    channel: 'stable',
  },
  doctorServer: {
    tag: 'v0.3.0',
    digest: 'sha256:dca',
    state: 'stopped',
    version: '0.3.0',
    channel: 'stable',
  },
  lastCheck: new Date().toISOString(),
};

const defaultSettings: VersionSettings = { showBeta: false, showMaster: false };

// No-drift default so the existing tests (which don't exercise the in-use
// drift action) keep rendering the inert "In use" text.
const noUpdates: AvailableUpdates = {
  signalkServer: { currentTag: 'unknown', updateAvailable: false, imageState: 'in-sync' },
  updater: { currentTag: 'unknown', updateAvailable: false },
  doctor: { currentTag: 'unknown', updateAvailable: false },
  lastCheckedAt: new Date().toISOString(),
};

// A dirkwa install whose in-use movable tag has a moved registry digest.
const dirkwaVersions: VersionsResponse = {
  cachedAt: new Date().toISOString(),
  channels: {
    stable: [],
    beta: [],
    master: [],
    dirkwa: [
      {
        name: 'dirkwa',
        channel: 'dirkwa',
        digest: 'sha256:newremote',
        pushedAt: '2026-06-15T05:04:00Z',
        isLocal: true,
      },
    ],
  },
};

const dirkwaState: CurrentState = {
  signalkServer: {
    tag: 'dirkwa',
    digest: 'sha256:oldlocal',
    state: 'running',
    version: '2.28.0-beta.2',
    channel: 'dirkwa',
    imageState: 'pull-available',
  },
  updaterServer: {
    tag: 'v0.6.19',
    digest: 'sha256:fed',
    state: 'running',
    updateAvailable: false,
    version: '0.6.19',
    channel: 'stable',
  },
  doctorServer: {
    tag: 'v0.3.0',
    digest: 'sha256:dca',
    state: 'stopped',
    version: '0.3.0',
    channel: 'stable',
  },
  lastCheck: new Date().toISOString(),
};

const dirkwaUpdates: AvailableUpdates = {
  signalkServer: {
    currentTag: '2.28.0-beta.2',
    updateAvailable: false,
    imageState: 'pull-available',
  },
  updater: { currentTag: 'unknown', updateAvailable: false },
  doctor: { currentTag: 'unknown', updateAvailable: false },
  lastCheckedAt: new Date().toISOString(),
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
    StubEventSource.instances = [];
    mockFetch({
      '/api/versions': sampleVersions,
      '/api/state': sampleState,
      '/api/versions/settings': defaultSettings,
      '/api/updates/available': noUpdates,
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

  it('dispatches POST /api/versions/pull and shows the spinner on Pull click', async () => {
    mockFetch({
      '/api/versions': sampleVersions,
      '/api/state': sampleState,
      '/api/versions/settings': defaultSettings,
      '/api/updates/available': noUpdates,
      // The pull route returns 202 immediately; the outcome arrives via SSE,
      // so the spinner stays up after the click (no terminal event in test).
      '/api/versions/pull': {
        ok: true,
        accepted: true,
        image: 'ghcr.io/dirkwa/signalk-server:v2.22.0',
      },
    });
    renderVersions();
    await screen.findByText('v2.22.0');
    const pullBtns = await screen.findAllByRole('button', { name: /^pull$/i });
    const pullBtn = pullBtns[0];
    if (!pullBtn) throw new Error('expected at least one Pull button');
    fireEvent.click(pullBtn);
    // The POST is dispatched...
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
        String(c[0]),
      );
      expect(calls.some((u) => u.includes('/api/versions/pull'))).toBe(true);
    });
    // ...and the button shows the in-flight "Pulling…" state (cleared later
    // by the SSE terminal event, which the inert test stub doesn't emit).
    expect(await screen.findByText(/pulling…/i)).toBeInTheDocument();
  });

  it('offers "Update & restart" on the in-use movable tag when its registry digest moved', async () => {
    mockFetch({
      '/api/versions': dirkwaVersions,
      '/api/state': dirkwaState,
      '/api/versions/settings': defaultSettings,
      '/api/updates/available': dirkwaUpdates,
    });
    renderVersions();
    await screen.findByText('current');
    // The in-use row is actionable, not the inert "In use" text.
    const btn = await screen.findByRole('button', { name: /update & restart/i });
    expect(btn).not.toBeDisabled();
    expect(screen.queryByText('In use')).not.toBeInTheDocument();
  });

  it('ignores doctor progress events (does not show a Switch-progress card)', async () => {
    renderVersions();
    await screen.findByText('stable');
    const es = StubEventSource.instances.at(-1);
    if (!es) throw new Error('expected an EventSource to be opened');
    // A doctor update streams over the SAME broker. The Versions card is
    // signalk-server-only and must ignore it (regression: it used to leak
    // a "Switch progress … doctor … Complete" card here).
    act(() => {
      es.emit({
        stage: 'complete',
        target: 'doctor',
        to: '0.7.17',
        message: 'Updated signalk-doctor-server to 0.7.17',
        at: new Date().toISOString(),
      });
    });
    expect(screen.queryByText('Switch progress')).not.toBeInTheDocument();
    expect(screen.queryByText(/signalk-doctor-server/i)).not.toBeInTheDocument();

    // A signalk-server event DOES render the card.
    act(() => {
      es.emit({
        stage: 'pulling',
        target: 'signalk-server',
        to: 'v2.27.0',
        message: 'Pulling v2.27.0…',
        at: new Date().toISOString(),
      });
    });
    expect(await screen.findByText('Switch progress')).toBeInTheDocument();
  });

  it('links the digest of a pinned stable tag to the upstream release page', async () => {
    renderVersions();
    await screen.findByText('v2.24.0');
    const link = screen.getByTitle(/sha256:aaa111 — release notes/);
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/SignalK/signalk-server/releases/tag/v2.24.0',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders base and PR links for a labeled dirkwa tag', async () => {
    const baseSha = 'a'.repeat(40);
    const labeledDirkwa: VersionsResponse = {
      cachedAt: new Date().toISOString(),
      channels: {
        stable: [],
        beta: [],
        master: [],
        dirkwa: [
          {
            name: 'dirkwa-dfb1444',
            channel: 'dirkwa',
            digest: 'sha256:labeled1',
            pushedAt: '2026-08-02T00:00:00Z',
            isLocal: false,
            labels: { baseSha, prs: '2588:7cf1e3b 2524:ef613fa' },
          },
        ],
      },
    };
    mockFetch({
      '/api/versions': labeledDirkwa,
      '/api/state': dirkwaState,
      '/api/versions/settings': defaultSettings,
      '/api/updates/available': noUpdates,
    });
    renderVersions();
    await screen.findByText('dirkwa-dfb1444');
    const pr = screen.getByRole('link', { name: '#2588' });
    expect(pr).toHaveAttribute('href', 'https://github.com/SignalK/signalk-server/pull/2588');
    expect(screen.getByRole('link', { name: '#2524' })).toBeInTheDocument();
    const base = screen.getByTitle('upstream base commit');
    expect(base).toHaveAttribute(
      'href',
      `https://github.com/SignalK/signalk-server/commit/${baseSha}`,
    );
    // Digest cell links to the base commit too (never the merge sha).
    expect(screen.getByTitle(/sha256:labeled1 — upstream base commit/)).toBeInTheDocument();
  });

  it('links label-less dirkwa digests to build history without base or PR metadata', async () => {
    mockFetch({
      '/api/versions': dirkwaVersions,
      '/api/state': dirkwaState,
      '/api/versions/settings': defaultSettings,
      '/api/updates/available': dirkwaUpdates,
    });
    renderVersions();
    await screen.findByText('current');
    const digest = screen.getByTitle(/sha256:newremote — build history/);
    expect(digest).toHaveAttribute(
      'href',
      'https://github.com/dirkwa/signalk-server-images/commits/main/state/last-dirkwa.txt',
    );
    // No stack labels → no base/PR detail line.
    expect(screen.queryByText(/PRs/)).not.toBeInTheDocument();
  });

  it('treats an absent target as signalk-server (backward compat with pre-discriminator events)', async () => {
    renderVersions();
    await screen.findByText('stable');
    const es = StubEventSource.instances.at(-1);
    if (!es) throw new Error('expected an EventSource to be opened');
    // Events published before the target discriminator existed have no
    // target field — they must still render (default signalk-server).
    act(() => {
      es.emit({
        stage: 'pulling',
        to: 'v2.25.0',
        message: 'Pulling v2.25.0…',
        at: new Date().toISOString(),
      });
    });
    expect(await screen.findByText('Switch progress')).toBeInTheDocument();
  });
});
