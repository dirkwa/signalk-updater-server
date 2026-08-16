import { readVersionSettings } from './version-settings.js';
import type { ImageRepoSource } from './types.js';

/**
 * Single source of truth for "which GHCR repository holds the
 * signalk-server images this install lists, pulls and switches to."
 *
 * Resolution order:
 *   1. the operator's Advanced-tab setting (`imageRepo` in
 *      version-settings.json), when set and still valid;
 *   2. the default — `SIGNALK_IMAGE` env when set and valid (a dev/test
 *      override; nothing ships it), else the built-in dirkwa repo.
 *
 * Nothing here reads env or disk at module scope: the routes resolve per
 * request and the switch resolves once per operation, so a setting change
 * takes effect without a restart and can't shift underneath a running
 * switch (which captures the resolved value up front).
 *
 * Scope is deliberately GHCR-only: `src/ghcr.ts` speaks to ghcr.io's token
 * + v2 endpoints and `src/image-drift.ts` only parses ghcr.io refs, so a
 * repo on another registry would list nothing and never report drift.
 * The validator rejects other hosts with a message that says so.
 */

export const BUILTIN_SIGNALK_IMAGE = 'ghcr.io/dirkwa/signalk-server';

const GHCR_HOST = 'ghcr.io';
// OCI distribution path-component grammar (lowercase alphanumerics with
// single `.`/`_`/`-` separators).
const SEGMENT_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export type NormalizeResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * Canonicalise a user-supplied repository into `ghcr.io/<owner>/<name>`.
 * Tolerates a pasted URL (`https://ghcr.io/owner/name/`), a bare path
 * (`owner/name`) and mixed case. Rejects tags, digests and non-GHCR hosts.
 */
export function normalizeImageRepo(raw: string): NormalizeResult {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/\/+$/, '');
  if (s === '') return { ok: false, error: 'Repository is empty.' };
  if (s.includes('@')) {
    return {
      ok: false,
      error: 'Digest pins (@sha256:…) are not supported — give the repository only.',
    };
  }
  const lastSlash = s.lastIndexOf('/');
  const lastColon = s.lastIndexOf(':');
  if (lastColon > lastSlash) {
    return {
      ok: false,
      error: 'Leave the tag off — the Versions tab picks the tag.',
    };
  }
  const segments = s.split('/');
  const first = segments[0] ?? '';
  if (first === GHCR_HOST) {
    segments.shift();
  } else if (first.includes('.') || first.includes(':')) {
    return { ok: false, error: `Only ghcr.io repositories are supported (got "${first}").` };
  }
  if (segments.length < 2) {
    return { ok: false, error: 'Use the form ghcr.io/<owner>/<name>.' };
  }
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg)) {
      return {
        ok: false,
        error: `Invalid path segment "${seg}" — lowercase letters, digits, and single . _ - separators only.`,
      };
    }
  }
  return { ok: true, value: `${GHCR_HOST}/${segments.join('/')}` };
}

/** `ghcr.io/owner/name` → `owner/name` (the form ghcr.ts and the local
 *  image matcher want). Passes through a value with no host untouched. */
export function ghcrPath(image: string): string {
  return image.startsWith(`${GHCR_HOST}/`) ? image.slice(GHCR_HOST.length + 1) : image;
}

/** `ghcr.io/owner/name:tag` → `ghcr.io/owner/name`. A ref without a tag
 *  (no colon after the last slash) is returned as-is. */
export function repoOfRef(ref: string): string {
  const withoutDigest = ref.split('@')[0] ?? ref;
  const lastSlash = withoutDigest.lastIndexOf('/');
  const lastColon = withoutDigest.lastIndexOf(':');
  return lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
}

/** The repo used when the operator hasn't set one: `SIGNALK_IMAGE` env if
 *  present and valid, else the built-in dirkwa repo. Read at call time. */
export function defaultSignalkImage(): string {
  const env = process.env.SIGNALK_IMAGE;
  if (env) {
    const n = normalizeImageRepo(env);
    if (n.ok) return n.value;
    console.warn(`signalk-image: ignoring invalid SIGNALK_IMAGE=${env}: ${n.error}`);
  }
  return BUILTIN_SIGNALK_IMAGE;
}

export interface ResolvedSignalkImage {
  /** Canonical `ghcr.io/<owner>/<name>` in effect right now. */
  image: string;
  source: ImageRepoSource;
  /** What `image` falls back to when the setting is cleared. */
  defaultImage: string;
}

export async function resolveSignalkImage(): Promise<ResolvedSignalkImage> {
  const defaultImage = defaultSignalkImage();
  const settings = await readVersionSettings();
  const stored: unknown = settings.imageRepo;
  if (typeof stored === 'string' && stored !== '') {
    // Re-validate what's on disk: the file is operator-editable and a
    // corrupt value must not silently fall back to (or masquerade as) a
    // repo the operator didn't choose.
    const n = normalizeImageRepo(stored);
    if (n.ok) return { image: n.value, source: 'setting', defaultImage };
    console.warn(`signalk-image: ignoring invalid stored imageRepo "${stored}": ${n.error}`);
  }
  return { image: defaultImage, source: 'default', defaultImage };
}
