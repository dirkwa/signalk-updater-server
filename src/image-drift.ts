import { resolveRuntime, safe } from './podman/client.js';
import { readQuadletImageRef } from './quadlet-image-tag.js';
import { headManifestDigest } from './ghcr.js';
import type { ImageState } from './types.js';

/**
 * Image-level staleness detection for a movable-tag container.
 *
 * The problem this exists to solve: for a rolling tag like `:dirkwa`
 * (re-pointed every few hours by the build, but always carrying the same
 * in-development semver, e.g. `2.28.0-beta.2`), the updater's semver
 * comparison in update-checker.ts is structurally blind. Two images built
 * a day apart report the identical package.json version, so
 * `compareSemver` always says "up to date" — even when:
 *
 *   1. a newer image has been pulled but the container never restarted
 *      onto it (it's still executing the old image id), or
 *   2. the tag has moved on GHCR but nothing has pulled the new image yet.
 *
 * Both are real "you are not running the latest" situations the semver
 * badge cannot represent. This module surfaces them as discrete states by
 * comparing three identities of the SAME tag:
 *
 *   remote(:tag on GHCR)  --A-->  local(:tag in store)  --B-->  running(container)
 *
 *   - B differs  => 'restart-required'  (pulled, not restarted)
 *   - A differs  => 'pull-available'    (tag moved on GHCR, not pulled)
 *   - both       => 'pull-and-restart'
 *   - neither    => 'in-sync'
 *   - can't tell => 'unknown'
 *
 * Comparison subtleties learned from the real data on this host:
 *
 *   - The running container's image is frequently DANGLING: pulling a new
 *     `:tag` moves the tag off the old image, leaving it with empty
 *     RepoTags/RepoDigests. So the running digest can NOT be read from the
 *     image's RepoDigests — it comes from the container inspect's podman-
 *     specific `.ImageDigest` field, with the image manifest `.Digest` as
 *     a fallback. (Docker has neither reliably; there the image-id compare
 *     below still works, and the digest compare degrades to 'unknown'.)
 *   - A single local image can carry MULTIPLE RepoDigests (manifest-list
 *     digest plus a re-pushed/secondary digest both seen for `:dirkwa`).
 *     And the manifest-list digest GHCR returns for a tag need not equal
 *     any single digest stored locally. So digest equality is matched by
 *     SET MEMBERSHIP, never `[0] === [0]`.
 *   - The restart check (B) is done primarily by IMAGE ID, which is exact
 *     and local: the id the container runs vs. the id the local tag
 *     resolves to. Digests are the cross-host/remote currency; ids are the
 *     local truth. We only fall back to digest-set comparison for B when
 *     an id is unavailable.
 */

export interface ImageDrift {
  state: ImageState;
  /** Manifest digest of the image the container is executing. Sourced from
   *  the container inspect's `.ImageDigest` (podman) or the image's
   *  `.Digest`. Null when neither is available. */
  runningDigest: string | null;
  /** Set of RepoDigests the local `:tag` resolves to. Empty when the tag
   *  isn't pulled locally or the inspect failed. */
  localTagDigests: string[];
  /** Manifest digest `:tag` points to on GHCR right now. Null when the
   *  registry couldn't be reached (offline) — `pull-available` is then
   *  suppressed rather than guessed. */
  remoteTagDigest: string | null;
}

const UNKNOWN: ImageDrift = {
  state: 'unknown',
  runningDigest: null,
  localTagDigests: [],
  remoteTagDigest: null,
};

interface ContainerInspectShape {
  Image?: string;
  ImageName?: string;
  // podman-only: the manifest digest of the running image, present even
  // when the image has been untagged (dangling).
  ImageDigest?: string;
}

interface ImageInspectShape {
  Id?: string;
  Digest?: string;
  RepoDigests?: string[] | null;
}

/** Split `ghcr.io/dirkwa/signalk-server:dirkwa` into its repo path
 *  (without the `ghcr.io/` prefix) and tag. Returns null for refs that
 *  aren't GHCR or have no tag — the remote check only knows how to talk
 *  to ghcr.io. */
function parseGhcrRef(ref: string): { image: string; tag: string } | null {
  const withoutDigest = ref.split('@')[0] ?? ref;
  const lastSlash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  if (colon === -1 || colon < lastSlash) return null;
  const repoWithRegistry = withoutDigest.slice(0, colon);
  const tag = withoutDigest.slice(colon + 1);
  if (!tag) return null;
  if (!repoWithRegistry.startsWith('ghcr.io/')) return null;
  return { image: repoWithRegistry.slice('ghcr.io/'.length), tag };
}

/** Resolve the running container's image id + manifest digest. The digest
 *  survives the image being dangling; the id is the exact local identity
 *  we compare the tag's resolved id against. */
async function resolveRunning(
  container: string,
): Promise<{ id: string | null; digest: string | null }> {
  const rt = await resolveRuntime();
  if (!rt) return { id: null, digest: null };
  const inspect = await safe(() => rt.client.getContainer(container).inspect());
  if (!inspect.ok) return { id: null, digest: null };
  const info = inspect.value as unknown as ContainerInspectShape;
  // `.Image` on a container inspect is the image id (a bare sha256 with no
  // path back to a tag); `.ImageName` is the ref the container was created
  // from. The id is what we want for the local-equality compare.
  const id = info.Image ?? null;
  let digest = info.ImageDigest ?? null;
  if (!digest && id) {
    // Fallback for runtimes without container .ImageDigest: read the
    // image's own manifest digest. (Works while the image still exists,
    // dangling or not.)
    const imgInspect = await safe(() => rt.client.getImage(id).inspect());
    if (imgInspect.ok) {
      const img = imgInspect.value as unknown as ImageInspectShape;
      digest = img.Digest ?? null;
    }
  }
  return { id, digest };
}

/** Resolve the local `:tag`'s image id + the set of digests it carries. */
async function resolveLocalTag(ref: string): Promise<{ id: string | null; digests: string[] }> {
  const rt = await resolveRuntime();
  if (!rt) return { id: null, digests: [] };
  const inspect = await safe(() => rt.client.getImage(ref).inspect());
  if (!inspect.ok) return { id: null, digests: [] };
  const img = inspect.value as unknown as ImageInspectShape;
  const id = img.Id ?? null;
  // RepoDigests are `repo@sha256:...`; keep just the digest half so the
  // set compares cleanly against the registry's bare digest header.
  const digests = (img.RepoDigests ?? [])
    .map((rd) => (rd.includes('@') ? rd.slice(rd.indexOf('@') + 1) : ''))
    .filter((d) => d.length > 0);
  return { id, digests };
}

/**
 * Compute the image-drift state for a container whose Quadlet pins a
 * GHCR tag. `checkRemote` controls whether the (network) `pull-available`
 * comparison runs — callers on a hot read path (`/api/state`) pass false
 * to get the zero-network `restart-required` answer instantly; the
 * scheduled/manual refresh paths pass true.
 */
export async function getImageDrift(
  container: string,
  quadletName: string,
  { checkRemote }: { checkRemote: boolean },
): Promise<ImageDrift> {
  const ref = await readQuadletImageRef(quadletName);
  // No movable tag (digest-pinned, unreadable, or tagless) => nothing to
  // drift against. Report unknown rather than a misleading 'in-sync'.
  if (!ref) return UNKNOWN;

  const [running, localTag] = await Promise.all([resolveRunning(container), resolveLocalTag(ref)]);

  // --- B: restart-required? local tag id != running id ---
  // Prefer exact image-id equality (local + exact). Only when an id is
  // missing do we fall back to digest-set overlap.
  let needsRestart: boolean | null;
  if (running.id && localTag.id) {
    needsRestart = running.id !== localTag.id;
  } else if (running.digest && localTag.digests.length > 0) {
    needsRestart = !localTag.digests.includes(running.digest);
  } else {
    needsRestart = null; // can't tell
  }

  // --- A: pull-available? remote tag digest not among local digests ---
  let pullAvailable: boolean | null = null;
  let remoteTagDigest: string | null = null;
  if (checkRemote) {
    const parsed = parseGhcrRef(ref);
    if (parsed) {
      remoteTagDigest = await headManifestDigest(parsed.image, parsed.tag);
      if (remoteTagDigest !== null && localTag.digests.length > 0) {
        pullAvailable = !localTag.digests.includes(remoteTagDigest);
      } else if (remoteTagDigest !== null && localTag.digests.length === 0) {
        // Tag resolves on GHCR but nothing is pulled locally — a pull is
        // certainly available.
        pullAvailable = true;
      }
    }
  }

  const state = deriveState(needsRestart, pullAvailable);
  return {
    state,
    runningDigest: running.digest,
    localTagDigests: localTag.digests,
    remoteTagDigest,
  };
}

/** Fold the two boolean (tri-state) checks into the wire enum. A null
 *  check is "couldn't determine" and never invents drift. When BOTH are
 *  null we surface 'unknown'; when at least one is determinable we report
 *  the strongest determinable state. */
export function deriveState(
  needsRestart: boolean | null,
  pullAvailable: boolean | null,
): ImageState {
  if (needsRestart === true && pullAvailable === true) return 'pull-and-restart';
  if (pullAvailable === true) return 'pull-available';
  if (needsRestart === true) return 'restart-required';
  if (needsRestart === null && pullAvailable === null) return 'unknown';
  // At least one check ran and neither found drift.
  return 'in-sync';
}
