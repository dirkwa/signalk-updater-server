import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const originalFetch = globalThis.fetch;

interface FakeRequest {
  url: string;
  init?: RequestInit;
}

interface FetchHandler {
  match: (url: string) => boolean;
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

/**
 * Stub globalThis.fetch with a tiny URL-router. Each handler runs its
 * `respond` callback in the order it was added — first match wins.
 * Records every request URL so tests can assert on request counts.
 */
function installFetchRouter(handlers: FetchHandler[]): { calls: FakeRequest[] } {
  const calls: FakeRequest[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    for (const h of handlers) {
      if (h.match(url)) return h.respond(url, init);
    }
    return new Response(`unhandled URL in test: ${url}`, { status: 599 });
  }) as typeof fetch;
  return { calls };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

beforeEach(async () => {
  const mod = await import('../src/ghcr.js');
  mod.__resetGhcrCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('listTags — digest-keyed pushedAt cache', () => {
  it('skips the blob fetch for tags whose digest is already cached', async () => {
    // Two tags pointing at the same digest. After the first scan, the
    // second scan should see one manifest fetch per tag (forced cache
    // bust on listTags but the digest cache survives) and zero blob
    // fetches.
    const SHARED_DIGEST = 'sha256:abc';
    const calls = installFetchRouter([
      // Anon token
      {
        match: (u) => u.startsWith('https://ghcr.io/token'),
        respond: () => jsonResponse({ token: 'fake-token' }),
      },
      // tags/list
      {
        match: (u) => u.includes('/tags/list'),
        respond: () => jsonResponse({ name: 'x/y', tags: ['v1', 'latest'] }),
      },
      // manifest for any tag/digest — always returns the same single-arch
      // manifest pointing at one config digest
      {
        match: (u) => u.includes('/manifests/'),
        respond: () =>
          jsonResponse(
            { schemaVersion: 2, config: { digest: 'sha256:configblob' } },
            { 'docker-content-digest': SHARED_DIGEST },
          ),
      },
      // blob: the config JSON with `created`
      {
        match: (u) => u.includes('/blobs/'),
        respond: () => jsonResponse({ created: '2026-05-22T09:43:58.595Z' }),
      },
    ]).calls;

    const { listTags } = await import('../src/ghcr.js');

    // First call: cold caches, expect 1 token + 1 tags/list + 2 manifests + 1 blob = 5
    // (blob only once because both tags share the digest and the second
    // tag finds it in the digest cache mid-scan).
    const first = await listTags('x/y', { force: true });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');
    expect(first.tags).toHaveLength(2);
    expect(first.tags[0]?.pushedAt).toBe('2026-05-22T09:43:58.595Z');
    expect(first.tags[1]?.pushedAt).toBe('2026-05-22T09:43:58.595Z');

    const blobCallsAfterFirst = calls.filter((c) => c.url.includes('/blobs/')).length;
    expect(blobCallsAfterFirst).toBe(1);

    // Second call with force=true: listTags cache is busted, but the
    // digest cache survives. Should issue manifests but no new blob
    // fetches.
    calls.length = 0;
    const second = await listTags('x/y', { force: true });
    expect(second.ok).toBe(true);
    const blobCallsAfterSecond = calls.filter((c) => c.url.includes('/blobs/')).length;
    expect(blobCallsAfterSecond).toBe(0);
  });

  it('caches negatives so a tag with no extractable pushedAt is not re-fetched', async () => {
    const calls = installFetchRouter([
      {
        match: (u) => u.startsWith('https://ghcr.io/token'),
        respond: () => jsonResponse({ token: 'fake-token' }),
      },
      {
        match: (u) => u.includes('/tags/list'),
        respond: () => jsonResponse({ name: 'x/y', tags: ['bad'] }),
      },
      {
        match: (u) => u.includes('/manifests/'),
        respond: () =>
          jsonResponse(
            { schemaVersion: 2, config: { digest: 'sha256:configblob' } },
            { 'docker-content-digest': 'sha256:bad' },
          ),
      },
      // Blob returns malformed JSON → fetchPushedAt returns null
      {
        match: (u) => u.includes('/blobs/'),
        respond: () => jsonResponse({ /* no `created` field */ wrong: true }),
      },
    ]).calls;

    const { listTags } = await import('../src/ghcr.js');

    const first = await listTags('x/y', { force: true });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');
    expect(first.tags[0]?.pushedAt).toBeNull();

    const blobCallsAfterFirst = calls.filter((c) => c.url.includes('/blobs/')).length;
    expect(blobCallsAfterFirst).toBe(1);

    // Second call: should NOT re-fetch the blob.
    calls.length = 0;
    await listTags('x/y', { force: true });
    const blobCallsAfterSecond = calls.filter((c) => c.url.includes('/blobs/')).length;
    expect(blobCallsAfterSecond).toBe(0);
  });
});

describe('listTags — manifest responses without docker-content-digest', () => {
  it('skips the offending tag and keeps well-formed tags', async () => {
    // Two tags: `good` responds with the digest header, `broken` without.
    // The digest is the identity everything downstream keys on (pull by
    // digest, drift comparison, config cache), so a header-less manifest
    // is treated like a deleted tag mid-scan — skipped, never surfaced
    // as a Tag with digest '' (issue #152).
    const calls = installFetchRouter([
      {
        match: (u) => u.startsWith('https://ghcr.io/token'),
        respond: () => jsonResponse({ token: 'fake-token' }),
      },
      {
        match: (u) => u.includes('/tags/list'),
        respond: () => jsonResponse({ name: 'x/y', tags: ['good', 'broken'] }),
      },
      {
        match: (u) => u.includes('/manifests/good'),
        respond: () =>
          jsonResponse(
            { schemaVersion: 2, config: { digest: 'sha256:goodcfg' } },
            { 'docker-content-digest': 'sha256:gooddigest' },
          ),
      },
      {
        // No docker-content-digest header on this one.
        match: (u) => u.includes('/manifests/broken'),
        respond: () => jsonResponse({ schemaVersion: 2, config: { digest: 'sha256:badcfg' } }),
      },
      {
        match: (u) => u.includes('/blobs/'),
        respond: () => jsonResponse({ created: '2026-08-02T00:00:00Z' }),
      },
    ]).calls;

    const { listTags } = await import('../src/ghcr.js');
    const r = await listTags('x/y', { force: true });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.tags.map((t) => t.name)).toEqual(['good']);
    expect(r.tags[0]?.digest).toBe('sha256:gooddigest');
    expect(r.tags.some((t) => t.digest === '')).toBe(false);
    // The broken tag's config blob was never fetched — we bail before
    // the blob round-trip.
    const blobCalls = calls.filter((c) => c.url.includes('/blobs/sha256:badcfg')).length;
    expect(blobCalls).toBe(0);
  });
});

describe('listTags — label capture from the config blob', () => {
  function routerWithBlob(blob: unknown) {
    return installFetchRouter([
      {
        match: (u) => u.startsWith('https://ghcr.io/token'),
        respond: () => jsonResponse({ token: 'fake-token' }),
      },
      {
        match: (u) => u.includes('/tags/list'),
        respond: () => jsonResponse({ name: 'x/y', tags: ['dirkwa-dfb1444'] }),
      },
      {
        match: (u) => u.includes('/manifests/'),
        respond: () =>
          jsonResponse(
            { schemaVersion: 2, config: { digest: 'sha256:configblob' } },
            { 'docker-content-digest': 'sha256:labeled' },
          ),
      },
      {
        match: (u) => u.includes('/blobs/'),
        respond: () => jsonResponse(blob),
      },
    ]);
  }

  it('captures whitelisted labels alongside pushedAt', async () => {
    const baseSha = 'a'.repeat(40);
    routerWithBlob({
      created: '2026-08-02T09:00:00Z',
      config: {
        Labels: {
          'org.opencontainers.image.version': '2.30.0',
          'org.opencontainers.image.revision': 'b'.repeat(40),
          'io.dirkwa.signalk.base-sha': baseSha,
          'io.dirkwa.signalk.prs': '2588:7cf1e3b 2524:ef613fa',
          'org.opencontainers.image.title': 'signalk-server',
        },
      },
    });
    const { listTags } = await import('../src/ghcr.js');
    const r = await listTags('x/y', { force: true });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.tags[0]?.pushedAt).toBe('2026-08-02T09:00:00.000Z');
    expect(r.tags[0]?.labels).toEqual({
      version: '2.30.0',
      revision: 'b'.repeat(40),
      baseSha,
      prs: '2588:7cf1e3b 2524:ef613fa',
    });
  });

  it('drops label values that fail their shape checks', async () => {
    routerWithBlob({
      created: '2026-08-02T09:00:00Z',
      config: {
        Labels: {
          'org.opencontainers.image.revision': 'not-a-sha!',
          'io.dirkwa.signalk.base-sha': '../../etc/passwd',
          'io.dirkwa.signalk.prs': '<script>alert(1)</script>',
          'org.opencontainers.image.version': '2.30.0',
        },
      },
    });
    const { listTags } = await import('../src/ghcr.js');
    const r = await listTags('x/y', { force: true });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.tags[0]?.labels).toEqual({ version: '2.30.0' });
  });

  it('omits the labels field entirely when the config has none', async () => {
    routerWithBlob({ created: '2026-08-02T09:00:00Z', config: {} });
    const { listTags } = await import('../src/ghcr.js');
    const r = await listTags('x/y', { force: true });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.tags[0]?.labels).toBeUndefined();
    expect('labels' in (r.tags[0] ?? {})).toBe(false);
  });

  it('still extracts labels when created is missing', async () => {
    routerWithBlob({
      config: { Labels: { 'org.opencontainers.image.version': '2.30.0' } },
    });
    const { listTags } = await import('../src/ghcr.js');
    const r = await listTags('x/y', { force: true });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.tags[0]?.pushedAt).toBeNull();
    expect(r.tags[0]?.labels).toEqual({ version: '2.30.0' });
  });
});

describe('listTags — bounded concurrency', () => {
  it('runs no more than FETCH_CONCURRENCY (8) manifest fetches simultaneously', async () => {
    // 20 tags, each manifest fetch deliberately slow (resolves on a
    // microtask cycle so we can count concurrent in-flight requests).
    const TAG_COUNT = 20;
    const tagNames = Array.from({ length: TAG_COUNT }, (_, i) => `t${i}`);
    let inFlight = 0;
    let maxInFlight = 0;

    installFetchRouter([
      {
        match: (u) => u.startsWith('https://ghcr.io/token'),
        respond: () => jsonResponse({ token: 'fake-token' }),
      },
      {
        match: (u) => u.includes('/tags/list'),
        respond: () => jsonResponse({ name: 'x/y', tags: tagNames }),
      },
      {
        // Each tag gets a unique digest so the digest cache never short-
        // circuits — every tag goes through the full manifest+blob path.
        match: (u) => u.includes('/manifests/'),
        respond: async (url) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((r) => setTimeout(r, 10));
          inFlight--;
          // Derive a unique digest from the URL so different tags
          // produce different headerDigests (avoids the digest-cache
          // collapse).
          const m = /\/manifests\/(.+)$/.exec(url);
          const ref = m?.[1] ?? 'unknown';
          return jsonResponse(
            { schemaVersion: 2, config: { digest: `sha256:cfg-${ref}` } },
            { 'docker-content-digest': `sha256:dig-${ref}` },
          );
        },
      },
      {
        match: (u) => u.includes('/blobs/'),
        respond: () => jsonResponse({ created: '2026-01-01T00:00:00Z' }),
      },
    ]);

    const { listTags } = await import('../src/ghcr.js');
    const r = await listTags('x/y', { force: true });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.tags).toHaveLength(TAG_COUNT);
    expect(maxInFlight).toBeLessThanOrEqual(8);
    // And > 1 — proves we actually parallelized (sequential would peak at 1)
    expect(maxInFlight).toBeGreaterThan(1);
  });
});

describe('listTags — transient registry failures classify as registry-unavailable', () => {
  it('surfaces a token-endpoint 502 as a retryable registry-unavailable error', async () => {
    // The token call is the FIRST GHCR request; a 502 there used to be
    // swallowed to a generic "failed to obtain token" → 'unknown' →
    // alarming "HTTP 502" in the UI. It must now classify as transient.
    installFetchRouter([
      {
        match: (u) => u.includes('/token'),
        respond: () => new Response('bad gateway', { status: 502 }),
      },
    ]);
    const { listTags } = await import('../src/ghcr.js');
    const r = await listTags('x/y', { force: true });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('registry-unavailable');
    expect(r.error.userMessage).toMatch(/temporarily unavailable|try again/i);
  });

  it('surfaces a tags/list 503 as registry-unavailable', async () => {
    installFetchRouter([
      { match: (u) => u.includes('/token'), respond: () => jsonResponse({ token: 't' }) },
      {
        match: (u) => u.includes('/tags/list'),
        respond: () => new Response('unavailable', { status: 503 }),
      },
    ]);
    const { listTags } = await import('../src/ghcr.js');
    const r = await listTags('x/y', { force: true });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('registry-unavailable');
  });
});
