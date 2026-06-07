import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Resolved per-call rather than at module load so tests (and the
// rare runtime that overrides QUADLET_DIR mid-process) see the right
// value. The cost is one env read per call — negligible against the
// fs read that follows.
function quadletDir(): string {
  return process.env.QUADLET_DIR ?? '/quadlets';
}

// Matches a 40+ hex-char digest, with or without the "sha256:" prefix.
// Used to detect when an `Image=` line was rewritten to a pinned digest
// (rare but possible if someone did `podman pull image@sha256:...` and
// rewrote the Quadlet by hand) — we treat that as "unknown" because the
// UI compares against semver tags.
const DIGEST_LIKE = /^(?:sha256:)?[0-9a-f]{40,}$/i;

/**
 * Read the tag suffix from a Quadlet's `Image=` line.
 *
 * The Quadlet is the source-of-truth for what the operator pinned —
 * dockerode `inspect` on a running container returns the resolved image
 * which, when the Quadlet uses `:latest`, is a sha256 digest with no
 * path back to the original tag. That's how the UI ended up greying out
 * the Doctor card's Update button: a digest doesn't sort against a
 * semver, so `compareSemver(latest, digest)` returns 0 and
 * `updateAvailable` falls through to `false`.
 *
 * Returns:
 *   - the tag suffix (everything after the last `:` on the Image= line),
 *     unless that suffix is itself a digest;
 *   - 'unknown' if the file can't be read or the parse fails.
 *
 * Caller is expected to chain a dockerode-inspect fallback if it wants
 * a "running tag" view — this helper only answers "what does the
 * Quadlet intend to run".
 */
export async function readQuadletImageTag(quadletName: string): Promise<string> {
  let body: string;
  try {
    body = await readFile(join(quadletDir(), quadletName), 'utf8');
  } catch {
    return 'unknown';
  }
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('Image=')) continue;
    const value = trimmed.slice('Image='.length).trim();
    // Strip an optional @sha256:... digest pin before extracting the tag.
    // `image@sha256:abc` → take `image`; then the colon-suffix step
    // returns `latest`-style tag if present, else 'unknown'.
    const withoutDigest = value.split('@')[0] ?? value;
    const colon = withoutDigest.lastIndexOf(':');
    if (colon === -1) return 'unknown';
    const tag = withoutDigest.slice(colon + 1);
    if (DIGEST_LIKE.test(tag) || tag === '') return 'unknown';
    return tag;
  }
  return 'unknown';
}

/**
 * Read the full `Image=` reference from a Quadlet — registry, repository,
 * and tag (e.g. `ghcr.io/dirkwa/signalk-server:dirkwa`). Unlike
 * {@link readQuadletImageTag}, which strips everything but the tag suffix,
 * this returns the whole ref so callers can inspect the local image the
 * ref resolves to and query the remote registry for the tag's current
 * digest. An `@sha256:...` digest pin is stripped — the drift check only
 * makes sense against a movable tag, and a digest-pinned Quadlet can never
 * drift by definition.
 *
 * Returns `null` when the file can't be read, no `Image=` line exists, or
 * the ref has no tag (a bare `repo` with no `:tag`, or a digest-only pin).
 */
export async function readQuadletImageRef(quadletName: string): Promise<string | null> {
  let body: string;
  try {
    body = await readFile(join(quadletDir(), quadletName), 'utf8');
  } catch {
    return null;
  }
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('Image=')) continue;
    const value = trimmed.slice('Image='.length).trim();
    const withoutDigest = value.split('@')[0] ?? value;
    // Reject refs with no tag. The colon must come after the last slash —
    // `ghcr.io:443/repo` has a registry-port colon but no tag, and a bare
    // `ghcr.io/dirkwa/signalk-server` has no colon at all.
    const lastSlash = withoutDigest.lastIndexOf('/');
    const colon = withoutDigest.lastIndexOf(':');
    if (colon === -1 || colon < lastSlash) return null;
    const tag = withoutDigest.slice(colon + 1);
    if (DIGEST_LIKE.test(tag) || tag === '') return null;
    return withoutDigest;
  }
  return null;
}
