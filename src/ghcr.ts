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
  // Present on multi-arch index/list manifests; absent on single-arch.
  manifests?: Array<{
    digest: string;
    mediaType?: string;
    platform?: { architecture?: string; os?: string };
  }>;
}

const MANIFEST_ACCEPT =
  'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json';

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

async function fetchManifest(
  image: string,
  ref: string,
  token: string,
): Promise<{ headerDigest: string; body: ManifestResponse }> {
  const res = await fetch(`https://ghcr.io/v2/${image}/manifests/${encodeURIComponent(ref)}`, {
    headers: { authorization: `Bearer ${token}`, accept: MANIFEST_ACCEPT },
  });
  if (!res.ok) throw new Error(`manifest: HTTP ${res.status}`);
  const headerDigest = res.headers.get('docker-content-digest') ?? '';
  const body = (await res.json()) as ManifestResponse;
  return { headerDigest, body };
}

/** Fetch the `created` timestamp from an image's OCI config blob.
 *
 *  This is the timestamp written by buildx into the image config at
 *  build time (RFC3339, e.g. `2026-05-22T09:43:58.595Z`). It's per
 *  digest, available unauthenticated via the same anonymous bearer
 *  we already hold, and survives the GH Packages REST API's
 *  "authentication required even for public packages" quirk that
 *  PR #73's prior implementation didn't catch — that one used the
 *  Packages API and silently 401'd, leaving every tag with no
 *  publish date in the UI ("—" everywhere on the Versions tab).
 *
 *  For multi-arch images the top-level manifest is an index/list with
 *  no `config`; we descend into the amd64/linux platform manifest
 *  (falling back to the first listed platform) and read THAT
 *  manifest's config. Same `created` for all platforms in practice
 *  since buildx tags them together.
 *
 *  Returns null on any failure — caller treats null as "unknown
 *  publish date" and the UI renders an em dash. */
async function fetchTagPublishedAt(
  image: string,
  tag: string,
  token: string,
): Promise<{ digest: string; pushedAt: string | null }> {
  const { headerDigest, body } = await fetchManifest(image, tag, token);
  let platformManifest: ManifestResponse = body;
  // Index → pick a platform manifest. amd64/linux preferred; first as fallback.
  if (Array.isArray(body.manifests) && body.manifests.length > 0) {
    const preferred =
      body.manifests.find(
        (m) => m.platform?.architecture === 'amd64' && m.platform?.os === 'linux',
      ) ?? body.manifests[0];
    if (!preferred) {
      return { digest: headerDigest, pushedAt: null };
    }
    try {
      const platform = await fetchManifest(image, preferred.digest, token);
      platformManifest = platform.body;
    } catch {
      return { digest: headerDigest, pushedAt: null };
    }
  }
  const configDigest = platformManifest.config?.digest;
  if (!configDigest) {
    return { digest: headerDigest, pushedAt: null };
  }
  try {
    // fetch() follows 302 redirects to the blob storage CDN by default.
    const blobRes = await fetch(`https://ghcr.io/v2/${image}/blobs/${configDigest}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!blobRes.ok) {
      return { digest: headerDigest, pushedAt: null };
    }
    // Narrow at the HTTP boundary — the blob is untrusted JSON, so we
    // refuse to let an arbitrary string cross into Tag.pushedAt and
    // poison downstream sorts / fmtTime calls. Parse with Date.parse
    // and re-emit canonical ISO8601 so the wire shape is uniform.
    const raw: unknown = await blobRes.json();
    const created =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>).created
        : undefined;
    if (typeof created !== 'string') {
      return { digest: headerDigest, pushedAt: null };
    }
    const ms = Date.parse(created);
    if (Number.isNaN(ms)) {
      return { digest: headerDigest, pushedAt: null };
    }
    return { digest: headerDigest, pushedAt: new Date(ms).toISOString() };
  } catch {
    return { digest: headerDigest, pushedAt: null };
  }
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
    const tagNames = await fetchTagList(image, token);
    const tags: Tag[] = [];
    // Manifest fetches are sequential and rate-aware; cap to MAX per call.
    const MAX = 80;
    const subset = tagNames.slice(-MAX); // newest tags are typically last in the list
    for (const name of subset) {
      try {
        const { digest, pushedAt } = await fetchTagPublishedAt(image, name, token);
        tags.push({ name, channel: classifyChannel(name), digest, pushedAt });
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
