import type { Tag } from './types';

/** Changelog-link derivation for the Versions table.
 *
 *  Maps a tag's channel + server-sanitized OCI labels to GitHub URLs a
 *  user can open to see "what's in this image". Pure presentation logic:
 *  the server ships facts (labels), this module decides where they lead.
 *
 *  Upstream mapping is intrinsic to this image family — every channel of
 *  ghcr.io/dirkwa/signalk-server is built from SignalK/signalk-server —
 *  so the repos are constants, not config.
 *
 *  Every value interpolated into an href is re-validated against a
 *  strict shape (sha / semver / PR number) even though the server
 *  already sanitized it; belt and suspenders against URL injection. */

const UPSTREAM_REPO = 'https://github.com/SignalK/signalk-server';
const IMAGES_REPO = 'https://github.com/dirkwa/signalk-server-images';

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const SEMVER_TAG_RE = /^v?(\d+\.\d+\.\d+(?:-(?:beta|rc)\.\d+)?)$/i;
const MASTER_TAG_RE = /^(?:master|main)-([0-9a-f]{4,40})$/i;
const PR_ENTRY_RE = /^(\d{1,6})(?::[0-9a-f]{7,40})?$/i;

export interface ChangelogLink {
  href: string;
  /** Short human label, used in tooltips ("release notes", "commit"). */
  label: string;
}

export interface DirkwaDetails {
  /** Upstream master commit the PR stack was merged onto, when known. */
  base: ChangelogLink | null;
  /** One link per merged upstream PR, in stack order. Text is "#NNNN". */
  prs: Array<ChangelogLink & { number: string }>;
}

function releaseLink(version: string): ChangelogLink | null {
  const m = version.match(SEMVER_TAG_RE);
  if (!m || m[1] === undefined) return null;
  return { href: `${UPSTREAM_REPO}/releases/tag/v${m[1]}`, label: 'release notes' };
}

function commitLink(sha: string, label = 'upstream commit'): ChangelogLink | null {
  if (!SHA_RE.test(sha)) return null;
  return { href: `${UPSTREAM_REPO}/commit/${sha}`, label };
}

/** Primary changelog link for a tag row, or null when nothing trustworthy
 *  can be derived (the UI then renders the digest unlinked, as today). */
export function changelogLinkFor(tag: Tag): ChangelogLink | null {
  const labels = tag.labels;
  switch (tag.channel) {
    case 'stable':
    case 'beta': {
      // Pinned semver tags (v2.30.0, 2.28.0-beta.2) map straight to the
      // upstream release page — that IS the changelog. Floating refs
      // (latest, beta) fall back to the version label, then the commit.
      const fromName = releaseLink(tag.name);
      if (fromName) return fromName;
      if (labels?.version) {
        const fromLabel = releaseLink(labels.version);
        if (fromLabel) return fromLabel;
      }
      // A value failing its shape check falls through to the next
      // derivation rather than killing the link outright.
      const fromRevision = labels?.revision ? commitLink(labels.revision) : null;
      if (fromRevision) return fromRevision;
      return null;
    }
    case 'master': {
      // The revision label is the exact upstream master commit; the tag
      // name's sha7 is the backup (GitHub resolves abbreviated SHAs).
      const fromRevision = labels?.revision ? commitLink(labels.revision) : null;
      if (fromRevision) return fromRevision;
      const m = tag.name.match(MASTER_TAG_RE);
      const fromName = m && m[1] !== undefined ? commitLink(m[1]) : null;
      if (fromName) return fromName;
      if (/^(master|main)$/i.test(tag.name)) {
        return { href: `${UPSTREAM_REPO}/commits/master`, label: 'upstream commit history' };
      }
      return null;
    }
    case 'dirkwa': {
      // NEVER link labels.revision here — for dirkwa images it is an
      // ephemeral CI merge commit that exists in no public repo (404).
      const fromBase = labels?.baseSha ? commitLink(labels.baseSha, 'upstream base commit') : null;
      if (fromBase) return fromBase;
      // Old label-less images: the build's state-file history in the
      // images repo is the only durable record of what went in.
      // classifyChannel buckets every unrecognized tag into dirkwa, so
      // gate on the actual tag prefix to avoid misleading links.
      if (/^dirkwa(-|$)/i.test(tag.name)) {
        return {
          href: `${IMAGES_REPO}/commits/main/state/last-dirkwa.txt`,
          label: 'build history',
        };
      }
      return null;
    }
  }
}

/** Base-commit + per-PR links for a dirkwa row, or null when the image
 *  carries no dirkwa stack labels (pre-label builds, other channels). */
export function dirkwaDetails(tag: Tag): DirkwaDetails | null {
  if (tag.channel !== 'dirkwa') return null;
  const labels = tag.labels;
  if (!labels?.baseSha && !labels?.prs) return null;
  const base = labels.baseSha ? commitLink(labels.baseSha, 'upstream base commit') : null;
  const prs: DirkwaDetails['prs'] = [];
  if (labels.prs) {
    for (const entry of labels.prs.split(' ')) {
      const m = entry.match(PR_ENTRY_RE);
      if (m && m[1] !== undefined) {
        prs.push({
          number: m[1],
          href: `${UPSTREAM_REPO}/pull/${m[1]}`,
          label: `PR #${m[1]}`,
        });
      }
    }
  }
  if (!base && prs.length === 0) return null;
  return { base, prs };
}

/** First 7 chars of a full sha for display next to the base link. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
