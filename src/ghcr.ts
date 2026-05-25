import type { Tag } from './types.js';
import { classifyChannel } from './tagClassifier.js';
import { categorizeError, type CategorizedError } from './errors.js';

interface CacheEntry {
  tags: Tag[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 6 * 60 * 60 * 1000;

interface TagsListResponse {
  name: string;
  tags?: string[];
}

interface ManifestResponse {
  config?: { digest?: string };
  schemaVersion?: number;
}

async function getAnonToken(image: string): Promise<string | null> {
  const url = `https://ghcr.io/token?scope=repository:${image}:pull&service=ghcr.io`;
  try {
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string };
    return body.token ?? null;
  } catch {
    return null;
  }
}

async function fetchTagList(image: string, token: string): Promise<string[]> {
  const all: string[] = [];
  let url: string | null = `https://ghcr.io/v2/${image}/tags/list?n=100`;
  while (url) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`tags/list: HTTP ${res.status}`);
    const body = (await res.json()) as TagsListResponse;
    if (body.tags) all.push(...body.tags);
    const link: string | null = res.headers.get('link');
    if (link && /rel="?next"?/i.test(link)) {
      const m = link.match(/<([^>]+)>/);
      url = m && m[1] ? new URL(m[1], 'https://ghcr.io').toString() : null;
    } else {
      url = null;
    }
  }
  return all;
}

async function fetchManifestDigest(
  image: string,
  tag: string,
  token: string,
): Promise<{ digest: string; size: number }> {
  const res = await fetch(`https://ghcr.io/v2/${image}/manifests/${encodeURIComponent(tag)}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept:
        'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json',
    },
  });
  if (!res.ok) throw new Error(`manifest: HTTP ${res.status}`);
  const digest = res.headers.get('docker-content-digest') ?? '';
  const body = (await res.json()) as ManifestResponse;
  let size = 0;
  // We don't traverse layers here; keep size 0 (unknown) for v1.
  void body;
  return { digest, size };
}

interface PackageVersion {
  name: string; // sha256:...
  updated_at: string; // ISO8601
  metadata?: { container?: { tags?: string[] } };
}

/** Build a `tag → updated_at` map for a GHCR package by calling the
 *  GitHub Packages API. The Docker Registry v2 manifest endpoint
 *  doesn't expose a reliable publish timestamp (no `Last-Modified`
 *  header on GHCR responses), so an earlier version of this file
 *  defaulted to `new Date()` and made every tag look "57s ago." This
 *  reads `updated_at` per version and flattens `metadata.container.tags`
 *  into the map.
 *
 *  Best-effort: the Packages API has a 60/hr anonymous rate limit and
 *  may rate-limit us mid-run. On failure the map is partial or empty
 *  and listTags falls back to `pushedAt: null` for unmapped tags. The
 *  UI shows `—` rather than fabricated data. */
async function fetchPackagePublishMap(image: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  // ghcr image is `<owner>/<package>`; the API path is
  // /users/<owner>/packages/container/<package>/versions.
  const slash = image.indexOf('/');
  if (slash <= 0) return map;
  const owner = image.slice(0, slash);
  const packageName = image.slice(slash + 1);
  let url: string | null =
    `https://api.github.com/users/${owner}/packages/container/${packageName}/versions?per_page=100`;
  while (url) {
    const res = await fetch(url, {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      // Don't throw — the caller treats a missing entry as "unknown
      // publish date" and the UI renders an em dash. Rate-limit is
      // the typical 60/hr anonymous case; we'll succeed on the next
      // 24h refresh.
      return map;
    }
    const body = (await res.json()) as PackageVersion[];
    for (const v of body) {
      const tags = v.metadata?.container?.tags ?? [];
      for (const tag of tags) {
        map.set(tag, v.updated_at);
      }
    }
    const link: string | null = res.headers.get('link');
    if (link && /rel="?next"?/i.test(link)) {
      const m = link.match(/<([^>]+)>/);
      url = m && m[1] ? m[1] : null;
    } else {
      url = null;
    }
  }
  return map;
}

export interface ListTagsResult {
  ok: true;
  tags: Tag[];
  cachedAt: string;
}

export interface ListTagsError {
  ok: false;
  error: CategorizedError;
}

export async function listTags(
  image: string,
  { force = false } = {},
): Promise<ListTagsResult | ListTagsError> {
  const cached = cache.get(image);
  if (!force && cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return { ok: true, tags: cached.tags, cachedAt: new Date(cached.fetchedAt).toISOString() };
  }
  try {
    const token = await getAnonToken(image);
    if (!token) {
      throw new Error('ghcr: failed to obtain anonymous pull token');
    }
    const [tagNames, publishMap] = await Promise.all([
      fetchTagList(image, token),
      fetchPackagePublishMap(image),
    ]);
    const tags: Tag[] = [];
    // Manifest fetches are sequential and rate-aware; cap to MAX_MANIFEST per call.
    const MAX = 80;
    const subset = tagNames.slice(-MAX); // newest tags are typically last in the list
    for (const name of subset) {
      try {
        const { digest } = await fetchManifestDigest(image, name, token);
        tags.push({
          name,
          channel: classifyChannel(name),
          digest,
          pushedAt: publishMap.get(name) ?? null,
        });
      } catch {
        // skip tags we can't fetch manifests for (e.g. deleted)
      }
    }
    cache.set(image, { tags, fetchedAt: Date.now() });
    return { ok: true, tags, cachedAt: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: categorizeError(err) };
  }
}

export function __resetGhcrCacheForTests(): void {
  cache.clear();
}
