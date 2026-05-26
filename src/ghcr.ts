import type { Tag } from './types.js';
import { classifyChannel } from './tagClassifier.js';
import { categorizeError, type CategorizedError } from './errors.js';

interface CacheEntry {
  tags: Tag[];
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 6 * 60 * 60 * 1000;

// Digest-keyed cache of the `created` timestamp from each image's OCI
// config blob. The blob is content-addressed by digest and immutable,
// so two tags pointing at the same digest (e.g. `:latest` + `:0.6.11`
// after a release) share the same pushedAt — we only need to fetch the
// blob once per unique digest, ever. Stays valid across the listTags
// per-image TTL (which only governs the tag→digest mapping, not the
// blob behind a digest). Memory footprint is negligible: ~200 bytes
// per entry, a few hundred entries total even after years of releases.
const pushedAtByDigest = new Map<string, string | null>();

// In-flight fetches keyed by digest. When two parallel workers both
// see the same digest mid-scan and neither has populated the cache
// yet, the first one's Promise lives here so the second worker can
// await it instead of re-fetching the same blob. Cleared from the
// map once the Promise settles (the resolved value lives in
// `pushedAtByDigest`).
const pendingByDigest = new Map<string, Promise<string | null>>();

// Bounded-concurrency knob for the per-tag manifest+blob fan-out. GHCR's
// anonymous rate-limit is ~5000 req/h, so 8 in-flight is well under
// budget even during a full uncached scan (80 tags × 3 requests / 8
// concurrent = ~30 round-trips ≈ 6s on a typical link). The previous
// sequential loop took ~30s.
const FETCH_CONCURRENCY = 8;

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

  // Digest-cache hit: pushedAt is per-digest and immutable, so a tag
  // pointing at a digest we've seen before doesn't need the platform-
  // manifest descent or the blob fetch. Two round-trips saved per
  // cache-hit tag.
  if (headerDigest && pushedAtByDigest.has(headerDigest)) {
    return {
      digest: headerDigest,
      pushedAt: pushedAtByDigest.get(headerDigest) ?? null,
    };
  }

  // Within-scan dedup: if another worker is already fetching this
  // digest's blob, await its Promise instead of issuing a duplicate
  // request. Saves N-1 blob roundtrips per shared-digest cluster
  // during a cold scan (typical for releases that touched `:latest`
  // and a semver tag in lockstep).
  if (headerDigest && pendingByDigest.has(headerDigest)) {
    const pushedAt = await pendingByDigest.get(headerDigest)!;
    return { digest: headerDigest, pushedAt };
  }

  const pending = fetchPushedAt(image, body, token);
  if (headerDigest) pendingByDigest.set(headerDigest, pending);
  const pushedAt = await pending;
  if (headerDigest) {
    // Cache negatives too — a tag we couldn't extract pushedAt from
    // (deleted blob, malformed config, etc.) won't suddenly start
    // working on the next scan, so don't re-fetch every 6h.
    pushedAtByDigest.set(headerDigest, pushedAt);
    pendingByDigest.delete(headerDigest);
  }
  return { digest: headerDigest, pushedAt };
}

async function fetchPushedAt(
  image: string,
  topManifest: ManifestResponse,
  token: string,
): Promise<string | null> {
  let platformManifest: ManifestResponse = topManifest;
  // Index → pick a platform manifest. amd64/linux preferred; first as fallback.
  if (Array.isArray(topManifest.manifests) && topManifest.manifests.length > 0) {
    const preferred =
      topManifest.manifests.find(
        (m) => m.platform?.architecture === 'amd64' && m.platform?.os === 'linux',
      ) ?? topManifest.manifests[0];
    if (!preferred) return null;
    try {
      const platform = await fetchManifest(image, preferred.digest, token);
      platformManifest = platform.body;
    } catch {
      return null;
    }
  }
  const configDigest = platformManifest.config?.digest;
  if (!configDigest) return null;
  try {
    // fetch() follows 302 redirects to the blob storage CDN by default.
    const blobRes = await fetch(`https://ghcr.io/v2/${image}/blobs/${configDigest}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!blobRes.ok) return null;
    // Narrow at the HTTP boundary — the blob is untrusted JSON, so we
    // refuse to let an arbitrary string cross into Tag.pushedAt and
    // poison downstream sorts / fmtTime calls. Parse with Date.parse
    // and re-emit canonical ISO8601 so the wire shape is uniform.
    const raw: unknown = await blobRes.json();
    const created =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>).created
        : undefined;
    if (typeof created !== 'string') return null;
    const ms = Date.parse(created);
    if (Number.isNaN(ms)) return null;
    return new Date(ms).toISOString();
  } catch {
    return null;
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
    // Cap to MAX so a runaway tag list (some images have thousands)
    // doesn't blow the round-trip budget. Newest tags are typically
    // last in the list — slice the tail.
    const MAX = 80;
    const subset = tagNames.slice(-MAX);
    const tags = await fetchTagsConcurrent(image, subset, token);
    cache.set(image, { tags, fetchedAt: Date.now() });
    return { ok: true, tags, cachedAt: new Date().toISOString() };
  } catch (err) {
    return { ok: false, error: categorizeError(err) };
  }
}

/**
 * Resolve `Tag` entries for the given tag names with bounded
 * concurrency. Tags whose manifest+blob fetch fails are silently
 * skipped (matches the prior sequential loop's behavior — a deleted
 * tag mid-scan shouldn't fail the whole `listTags` call). Returns
 * results in the input order so the caller's expectations about
 * "newest last" still hold.
 */
async function fetchTagsConcurrent(image: string, names: string[], token: string): Promise<Tag[]> {
  const results: Array<Tag | null> = new Array(names.length).fill(null);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= names.length) return;
      const name = names[i]!;
      try {
        const { digest, pushedAt } = await fetchTagPublishedAt(image, name, token);
        results[i] = { name, channel: classifyChannel(name), digest, pushedAt };
      } catch {
        // skip tags we can't fetch manifests for (e.g. deleted)
      }
    }
  }
  const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, names.length) }, worker);
  await Promise.all(workers);
  return results.filter((t): t is Tag => t !== null);
}

/** Bust the listTags cache for one image (or all, if no arg). Called from
 *  update-checker.triggerCheck so the manual "Check now" button and the
 *  scheduled tick see fresh GHCR data — without this, the 6h listTags
 *  cache silently masks tags published in the last 6 hours. */
export function clearListTagsCache(image?: string): void {
  if (image === undefined) {
    cache.clear();
  } else {
    cache.delete(image);
  }
}

export function __resetGhcrCacheForTests(): void {
  cache.clear();
  pushedAtByDigest.clear();
  pendingByDigest.clear();
}
