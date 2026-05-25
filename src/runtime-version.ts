import { resolveRuntime, safe } from './podman/client.js';
import { classifyChannel, isSemverTag } from './tagClassifier.js';
import { readQuadletImageTag } from './quadlet-image-tag.js';
import type { Channel } from './types.js';

/**
 * Three-tier resolver for a container's "running version".
 *
 * The architectural mistake we're correcting: four different code paths
 * tried to extract a tag from dockerode's `inspect().Image`. That field
 * is a sha256 digest when the Quadlet pins a floating tag like
 * `:latest`, because podman resolves the floating ref to an immutable
 * layer hash at pull time. There is no way back to the original tag —
 * the runtime simply doesn't know.
 *
 * The Quadlet's `Image=` line is OperatorIntent ("what should podman
 * start next?"). It can be a floating tag, a semver, or anything else.
 * It is NOT a reliable answer to "what version is this running?".
 *
 * The engine itself IS that answer. Both engine containers expose
 * `/api/health` returning their package.json version, set at release
 * time. The OCI image label `org.opencontainers.image.version` (set by
 * the publish workflow at build time) is the backup when the engine
 * can't be reached. The Quadlet tag is the last-ditch fallback —
 * useful for floating-tag-aware UIs, useless as a version string.
 */

export type IdentitySource = 'health' | 'image-label' | 'quadlet-tag' | 'unknown';

export interface RuntimeIdentity {
  /** Semver string ("0.6.3") when known, null when no source could answer. */
  version: string | null;
  /** Which fallback layer answered. Mainly useful for diagnostics + tests. */
  source: IdentitySource;
  /** OperatorIntent channel classification from the Quadlet's Image= tag. */
  channel: Channel | 'unknown';
}

export interface VersionTarget {
  /** Container name as podman sees it (for the OCI-label fallback). */
  container: string;
  /** Quadlet filename under QUADLET_DIR (for the OperatorIntent channel). */
  quadletName: string;
  /** Optional HTTP health endpoint that returns `{ version: "..." }`.
   *  Set for both engine containers; absent for signalk-server. */
  healthUrl?: string;
  /** Optional shortcut for our own container: read the cached
   *  package.json version directly instead of fetching over HTTP.
   *  Set to `getSelfVersion` for the updater itself. */
  selfVersion?: () => string;
}

const HEALTH_TIMEOUT_MS = 3000;

async function probeHealth(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    if (typeof body.version !== 'string') return null;
    if (body.version === '' || body.version === 'unknown') return null;
    return body.version;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface DockerodeImageInspect {
  Config?: { Labels?: Record<string, string> | null };
}

async function probeImageLabel(container: string): Promise<string | null> {
  const rt = await resolveRuntime();
  if (!rt) return null;
  // Get the container's inspect first to learn which image it's running,
  // then inspect THAT image for its labels — the container inspect's
  // Config.Labels are the container-runtime labels, not the image labels.
  const containerInspect = await safe(() => rt.client.getContainer(container).inspect());
  if (!containerInspect.ok) return null;
  const info = containerInspect.value as unknown as { Image?: string; ImageName?: string };
  const imageRef = info.ImageName ?? info.Image ?? '';
  if (!imageRef) return null;
  const imageInspect = await safe(() => rt.client.getImage(imageRef).inspect());
  if (!imageInspect.ok) return null;
  const img = imageInspect.value as unknown as DockerodeImageInspect;
  const label = img.Config?.Labels?.['org.opencontainers.image.version'];
  if (typeof label !== 'string' || label.length === 0) return null;
  // The workflow sets the label to `${{ github.ref_name }}` which is
  // "v0.6.3" (with the `v`). Strip the prefix so the field is a clean
  // semver consistent with /api/health.
  const stripped = label.startsWith('v') ? label.slice(1) : label;
  // isSemverTag's regex already accepts both `v0.6.3` and `0.6.3`, so a
  // single check on the stripped form covers both.
  return isSemverTag(stripped) ? stripped : null;
}

/**
 * Resolve a container's RuntimeIdentity by walking the three-tier
 * fallback. Returns the first source that produces a non-null version;
 * `channel` always reflects the Quadlet's OperatorIntent classification
 * regardless of which version source won.
 */
export async function getRuntimeIdentity(target: VersionTarget): Promise<RuntimeIdentity> {
  const quadletTag = await readQuadletImageTag(target.quadletName);
  const channel: Channel | 'unknown' =
    quadletTag === 'unknown' ? 'unknown' : classifyChannel(quadletTag);

  // Tier 1a: self shortcut — when the caller is the updater itself, read
  // the in-process cached package.json version. Avoids a round-trip to
  // our own port, and avoids the chicken-and-egg if we're mid-restart.
  if (target.selfVersion) {
    const v = target.selfVersion();
    if (v && v !== 'unknown') {
      return { version: v, source: 'health', channel };
    }
  }

  // Tier 1b: HTTP health probe to a sibling engine.
  if (target.healthUrl) {
    const v = await probeHealth(target.healthUrl);
    if (v !== null) {
      return { version: v, source: 'health', channel };
    }
  }

  // Tier 2: OCI image label. Authoritative for images whose publish
  // workflow stamps `org.opencontainers.image.version`.
  const label = await probeImageLabel(target.container);
  if (label !== null) {
    return { version: label, source: 'image-label', channel };
  }

  // Tier 3: Quadlet Image= tag suffix. Only counts as a version when the
  // operator pinned a semver-shaped tag; floating tags like `:latest` or
  // `:dirkwa` produce no version answer but still inform `channel`.
  if (isSemverTag(quadletTag)) {
    return { version: quadletTag, source: 'quadlet-tag', channel };
  }

  return { version: null, source: 'unknown', channel };
}
