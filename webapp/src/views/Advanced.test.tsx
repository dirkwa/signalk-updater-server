import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Advanced } from './Advanced';
import { ToastProvider } from '../toast';
import type { VersionSettingsResponse } from '../types';

// Snapshot the real fetch at module load and restore in afterEach —
// vi.restoreAllMocks() doesn't undo a direct global assignment.
const originalFetch = globalThis.fetch;

const defaultSettings: VersionSettingsResponse = {
  showBeta: false,
  showMaster: false,
  imageRepo: null,
  effectiveImageRepo: 'ghcr.io/dirkwa/signalk-server',
  imageRepoSource: 'default',
  defaultImageRepo: 'ghcr.io/dirkwa/signalk-server',
};

const forkSettings: VersionSettingsResponse = {
  ...defaultSettings,
  imageRepo: 'ghcr.io/someone/signalk-server',
  effectiveImageRepo: 'ghcr.io/someone/signalk-server',
  imageRepoSource: 'setting',
};

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

/**
 * Stateful fetch stub: GET returns the current settings; PUT records the
 * call and either applies `putResponder` or echoes the merged settings.
 */
function mockSettingsFetch(
  initial: VersionSettingsResponse,
  putResponder?: (body: { imageRepo?: string | null }) => Response | VersionSettingsResponse,
): { calls: Recorded[] } {
  let current = initial;
  const calls: Recorded[] = [];
  globalThis.fetch = vi.fn(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(url, 'http://localhost').pathname;
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      if (path !== '/api/versions/settings') {
        return new Response(JSON.stringify({ error: 'not mocked' }), { status: 404 });
      }
      if (method === 'PUT') {
        const r = putResponder?.(body as { imageRepo?: string | null });
        if (r instanceof Response) return r;
        if (r) current = r;
        else {
          const repo = (body as { imageRepo?: string | null }).imageRepo ?? null;
          current = {
            ...current,
            imageRepo: repo,
            effectiveImageRepo: repo ?? current.defaultImageRepo,
            imageRepoSource: repo ? 'setting' : 'default',
          };
        }
      }
      return new Response(JSON.stringify(current), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  ) as typeof fetch;
  return { calls };
}

function renderAdvanced() {
  return render(
    <ToastProvider>
      <Advanced />
    </ToastProvider>,
  );
}

describe('Advanced', () => {
  beforeEach(() => {
    // Each test installs its own fetch stub.
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('shows the effective repo, its source, and no reset button by default', async () => {
    mockSettingsFetch(defaultSettings);
    renderAdvanced();
    expect(await screen.findByText('ghcr.io/dirkwa/signalk-server')).toBeInTheDocument();
    expect(screen.getByText(/\(default\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reset to default/i })).not.toBeInTheDocument();
    const input = screen.getByLabelText('Repository') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('ghcr.io/dirkwa/signalk-server');
    // Nothing typed yet → Save disabled.
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('PUTs the typed repo and reflects the server response', async () => {
    const { calls } = mockSettingsFetch(defaultSettings);
    renderAdvanced();
    const input = await screen.findByLabelText('Repository');
    fireEvent.change(input, { target: { value: 'ghcr.io/someone/signalk-server' } });
    const save = screen.getByRole('button', { name: /save/i });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    });
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({ imageRepo: 'ghcr.io/someone/signalk-server' });
    expect(await screen.findByText(/\(custom setting\)/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /reset to default/i })).toBeInTheDocument();
  });

  it('surfaces the server validation error inline', async () => {
    mockSettingsFetch(
      defaultSettings,
      () =>
        new Response(JSON.stringify({ error: 'Only ghcr.io repositories are supported.' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    renderAdvanced();
    const input = await screen.findByLabelText('Repository');
    fireEvent.change(input, { target: { value: 'docker.io/x/y' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    // Inline feedback under the field + toast both carry the message;
    // assert at least one rendered.
    expect(
      (await screen.findAllByText(/Only ghcr\.io repositories are supported/)).length,
    ).toBeGreaterThan(0);
    // The stored/effective repo is unchanged.
    expect(screen.getByText('ghcr.io/dirkwa/signalk-server')).toBeInTheDocument();
  });

  it('Reset to default PUTs imageRepo: null', async () => {
    const { calls } = mockSettingsFetch(forkSettings);
    renderAdvanced();
    await screen.findByLabelText('Repository');
    // The input is seeded from the loaded setting in an effect — wait for it.
    await waitFor(() => {
      expect((screen.getByLabelText('Repository') as HTMLInputElement).value).toBe(
        'ghcr.io/someone/signalk-server',
      );
    });
    fireEvent.click(await screen.findByRole('button', { name: /reset to default/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    });
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ imageRepo: null });
    await waitFor(() => {
      expect((screen.getByLabelText('Repository') as HTMLInputElement).value).toBe('');
    });
    expect(screen.getByText(/\(default\)/)).toBeInTheDocument();
  });
});
