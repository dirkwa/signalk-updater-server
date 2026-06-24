import type { FastifyBaseLogger } from 'fastify';
import { resolveRuntime, safe } from './podman/client.js';
import { isSemverTag, compareSemver } from './tagClassifier.js';

/**
 * Tagged-image retention for the three engine images.
 *
 * Every version switch / self-update pulls a new `:<semver>` and repoints
 * the rolling tag (`:latest` / `:dirkwa`), but the PRIOR semver tag is never
 * removed — so old versions accumulate on disk forever (~290 MB each for the
 * peer engines, ~1.3 GB for signalk-server). Nothing else reclaims them: the
 * installer's prunes are dangling-only (`<none>` layers), and an old semver
 * tag is a real RepoTag, not dangling.
 *
 * `podman image prune` cannot express "tagged-but-not-in-my-keep-list" — it is
 * dangling-only or all-unused (`-a`, which would also delete a version the
 * operator kept for rollback). So we remove a COMPUTED keep-list by tag.
 *
 * Safety is built on protecting image IDs, not tag strings:
 *   - the running container's image is protected by ID,
 *   - the rolling tags (`:latest`, …) are protected by the ID they resolve to,
 *   - the `keep` most-recent OTHER semver tags are kept for rollback.
 * A candidate tag that shares an ID with any protected entry (the common
 * `:0.6.27` == `:latest` case) is therefore never a removal candidate, so
 * untagging it can never strand another tag's layers.
 *
 * Best-effort throughout: a failed `rmi`, a missing runtime, or a locked layer
 * degrades to a no-op. This must NEVER fail the switch/self-update that calls it.
 */

/** dockerode listImages() row — only the fields we read. */
interface ImageInfo {
  Id: string;
  RepoTags?: string[] | null;
  Created: number;
}

/** dockerode container inspect() — only the image-id fields we read. */
interface ContainerInspect {
  Image?: string;
  ImageName?: string;
}

export interface RetentionOptions {
  /** How many OTHER semver tags to retain for rollback, newest-first. Default 1. */
  keep?: number;
  /** Rolling tags never to remove (the ID they resolve to is protected). */
  protectTags?: string[];
}

export interface RetentionResult {
  removed: string[];
  kept: string[];
  skipped: string[];
}

const EMPTY: RetentionResult = { removed: [], kept: [], skipped: [] };

/** A locally-present `<repo>:<tag>` with its resolved image id and age. */
interface TaggedImage {
  repoTag: string;
  tag: string;
  id: string;
  created: number;
}

/** Does this RepoTag's repo half match the prefix (bare or ghcr-prefixed)? */
function repoMatches(repo: string, prefix: string): boolean {
  const bare = prefix.replace(/^ghcr\.io\//, '');
  return repo === prefix || repo === bare || repo === `ghcr.io/${bare}`;
}

/**
 * Remove old tagged images under `repoPrefix`, keeping the running image, the
 * rolling tags, and the `keep` most-recent semver versions.
 *
 * @param repoPrefix       e.g. 'ghcr.io/dirkwa/signalk-updater-server'
 * @param runningContainer container whose image must never be removed, e.g. 'signalk-server'
 */
export async function pruneOldImagesFor(
  repoPrefix: string,
  runningContainer: string,
  opts: RetentionOptions = {},
  log?: FastifyBaseLogger,
): Promise<RetentionResult> {
  const keep = opts.keep ?? 1;
  // Always protect the common rolling tags, even on a bare call: a default
  // invocation must never be able to remove :latest / :dirkwa. Callers add
  // engine-specific rolling tags (e.g. :master, :beta) on top.
  const protectTags = new Set<string>(['latest', 'dirkwa', ...(opts.protectTags ?? [])]);

  const rt = await resolveRuntime();
  if (!rt) return EMPTY;

  const listed = await safe(() => rt.client.listImages({}));
  if (!listed.ok) return EMPTY;

  // Collect this repo's locally-present tagged images (drop <none>).
  const tagged: TaggedImage[] = [];
  for (const img of listed.value as ImageInfo[]) {
    if (!img.RepoTags) continue;
    for (const repoTag of img.RepoTags) {
      const colon = repoTag.lastIndexOf(':');
      if (colon === -1) continue;
      const repo = repoTag.slice(0, colon);
      const tag = repoTag.slice(colon + 1);
      if (tag === '<none>' || repo === '<none>') continue;
      if (!repoMatches(repo, repoPrefix)) continue;
      tagged.push({ repoTag, tag, id: img.Id, created: img.Created });
    }
  }
  if (tagged.length === 0) return EMPTY;

  // Build the protect-by-ID set. Protecting by ID (never by tag string) is what
  // makes untagging safe when several tags share one image id.
  const protectedIds = new Set<string>();

  // (a) the running container's image id.
  const inspected = await safe(() => rt.client.getContainer(runningContainer).inspect());
  if (inspected.ok) {
    // NOTE: this id is used ONLY as a protect-set membership key — never parsed
    // for a version string (runtime-version.ts owns RuntimeIdentity). Reading
    // the id here does not reintroduce the inspect().Image version anti-pattern.
    const info = inspected.value as unknown as ContainerInspect;
    const runId = info.Image ?? info.ImageName;
    if (runId) protectedIds.add(runId);
  }

  // (b) the ids that rolling tags resolve to.
  for (const t of tagged) {
    if (protectTags.has(t.tag)) protectedIds.add(t.id);
  }

  // (c) the `keep` most-recent semver versions for rollback, newest-first —
  // but counted among versions NOT already protected above. The running/rolling
  // image is usually itself a semver (e.g. :0.6.27 == :latest); letting it
  // consume the keep budget would push the genuinely-previous version (:0.6.25)
  // out of the window and delete the one tag rollback needs. Skip ids already
  // protected so `keep` measures rollback depth, not total semver count.
  const semverNewestFirst = tagged
    .filter((t) => isSemverTag(t.tag))
    .sort((a, b) => compareSemver(b.tag, a.tag));
  let kept = 0;
  for (const t of semverNewestFirst) {
    if (kept >= keep) break;
    if (protectedIds.has(t.id)) continue;
    protectedIds.add(t.id);
    kept++;
  }

  // Remove every tag whose id is not protected. force:false so a still-referenced
  // layer refuses rather than cascading; safe() so any error is a no-op skip.
  const result: RetentionResult = { removed: [], kept: [], skipped: [] };
  for (const t of tagged) {
    if (protectedIds.has(t.id)) {
      result.kept.push(t.repoTag);
      continue;
    }
    const removed = await safe(() => rt.client.getImage(t.repoTag).remove({ force: false }));
    if (removed.ok) result.removed.push(t.repoTag);
    else result.skipped.push(t.repoTag);
  }

  if (result.removed.length > 0) {
    log?.info(
      { removed: result.removed, kept: result.kept, skipped: result.skipped },
      `image-retention: reclaimed ${result.removed.length} old image(s) for ${repoPrefix}`,
    );
  }
  return result;
}
