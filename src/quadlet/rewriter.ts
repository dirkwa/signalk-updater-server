import { open, mkdir, readFile, rename, copyFile, readdir, stat, unlink } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';

const QUADLET_DIR = process.env.QUADLET_DIR ?? '/quadlets';
const DOCTOR_DATA = process.env.DOCTOR_DATA ?? '/doctor-data';
const SNAPSHOT_DIR = join(DOCTOR_DATA, 'snapshots');
const LAST_GOOD_PATH = join(DOCTOR_DATA, 'last-good.json');

export interface LastGood {
  updatedAt: string;
  quadlets: Record<string, { tag: string; image: string; snapshotPath: string }>;
}

async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function writeAtomic(filePath: string, body: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.tmp`;
  const fh = await open(tmp, 'w', 0o644);
  try {
    await fh.write(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, filePath);
  await fsyncDir(dirname(filePath));
}

export async function ensureDirs(): Promise<void> {
  await mkdir(SNAPSHOT_DIR, { recursive: true });
}

export async function readQuadlet(quadletName: string): Promise<string> {
  return (await readFile(join(QUADLET_DIR, quadletName), 'utf8')).toString();
}

export async function snapshotQuadlet(quadletName: string): Promise<string> {
  await ensureDirs();
  const src = join(QUADLET_DIR, quadletName);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snap = join(SNAPSHOT_DIR, `${ts}-${quadletName}`);
  await copyFile(src, snap);
  return snap;
}

export async function pruneSnapshots(quadletName: string, keep = 10): Promise<void> {
  await ensureDirs();
  const all = (await readdir(SNAPSHOT_DIR))
    .filter((n) => n.endsWith(`-${quadletName}`))
    .map((n) => join(SNAPSHOT_DIR, n));
  if (all.length <= keep) return;
  const withMtime: Array<{ p: string; m: number }> = [];
  for (const p of all) {
    const s = await stat(p);
    withMtime.push({ p, m: s.mtimeMs });
  }
  withMtime.sort((a, b) => b.m - a.m);
  for (const { p } of withMtime.slice(keep)) {
    try {
      await unlink(p);
    } catch {
      // best-effort
    }
  }
}

/**
 * Rewrite a single `Image=` line in a Quadlet file with a new tag.
 * Preserves the image base; only swaps the tag portion (text after the last `:`).
 *
 * Returns the previous image string for rollback.
 */
export function rewriteImageLine(
  body: string,
  newImage: string,
): { body: string; previous: string } {
  const lines = body.split('\n');
  let previous = '';
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (/^Image\s*=/i.test(line.trim()) && !found) {
      const m = line.match(/^(\s*)Image\s*=\s*(.*)$/i);
      if (m && m[1] !== undefined && m[2] !== undefined) {
        previous = m[2].trim();
        lines[i] = `${m[1]}Image=${newImage}`;
        found = true;
      }
    }
  }
  if (!found) throw new Error('Image= line not found in Quadlet');
  return { body: lines.join('\n'), previous };
}

export async function rewriteQuadletImage(
  quadletName: string,
  newImage: string,
): Promise<{ snapshotPath: string; previousImage: string }> {
  const filePath = join(QUADLET_DIR, quadletName);
  const original = await readQuadlet(quadletName);
  const snapshotPath = await snapshotQuadlet(quadletName);
  const { body, previous } = rewriteImageLine(original, newImage);
  await writeAtomic(filePath, body);
  await pruneSnapshots(quadletName);
  return { snapshotPath, previousImage: previous };
}

/**
 * Read a Quadlet, snapshot it (CC-1), apply a pure `transform` to its body, and
 * atomically write the result + prune snapshots. The single sanctioned path for
 * code that needs to mutate a Quadlet body it can't express as an image/boot
 * tweak (e.g. the charts CHARTS-block splice). Returns the PRE-write body so the
 * caller can roll back with `restoreQuadletBody` if a downstream step (restart /
 * health) fails.
 */
export async function rewriteQuadletBody(
  quadletName: string,
  transform: (body: string) => string,
): Promise<{ snapshotPath: string; original: string }> {
  const filePath = join(QUADLET_DIR, quadletName);
  const original = await readQuadlet(quadletName);
  const snapshotPath = await snapshotQuadlet(quadletName);
  await writeAtomic(filePath, transform(original));
  await pruneSnapshots(quadletName);
  return { snapshotPath, original };
}

/**
 * Restore a Quadlet body (used by rollback paths). Snapshots first (CC-1: every
 * Quadlet write snapshots) so the failed-forward body is captured as a
 * breadcrumb right when recovery/debugging needs it, then atomic-writes the
 * restored body and prunes. Returns the snapshot path.
 */
export async function restoreQuadletBody(quadletName: string, body: string): Promise<string> {
  const filePath = join(QUADLET_DIR, quadletName);
  const snapshotPath = await snapshotQuadlet(quadletName);
  await writeAtomic(filePath, body);
  await pruneSnapshots(quadletName);
  return snapshotPath;
}

// Marker the updater stamps onto the boot-start line it disables, so a later
// resume can find and restore exactly the line it commented out (and never
// touch a user-authored WantedBy). Quadlet's generator only honours the
// [Install] section's WantedBy/RequiredBy/Alias keys to decide boot-start
// (podman-systemd.unit(5): "only the Alias, WantedBy and RequiredBy keys are
// supported"), so commenting the WantedBy line out removes the default.target
// wants symlink the generator would otherwise create — and it stays removed
// across daemon-reload because the unit is regenerated from this (rewritten)
// source every time. That is what makes a `signalk stop` durable across reboot
// without ever touching systemd enablement on a generated unit (which `disable`
// can't durably do and `mask` is denied for).
const BOOT_START_MARKER = '#SK-PAUSED# ';

// Match a WantedBy= line (active or already-marked). Only meaningful INSIDE the
// [Install] section — the generator ignores WantedBy= anywhere else — so the
// loop below gates this on section tracking. We only ever write one
// (default.target) but tolerate a hand-edited multi-target line by commenting
// the whole line as a unit.
const WANTED_BY_RE = /^(\s*)(#SK-PAUSED#\s)?\s*(WantedBy\s*=.*)$/;

// A bare `[Section]` header line. Used to know when we're inside [Install].
const SECTION_RE = /^\s*\[([^\]]+)\]\s*$/;

/**
 * Toggle whether this Quadlet starts at boot, by commenting / uncommenting its
 * `[Install] WantedBy=` line with an updater-owned marker.
 *
 * - `enabled: false` (pause): prefix the active `[Install] WantedBy=` line with
 *   `#SK-PAUSED# ` so the generator no longer wires the unit into
 *   `default.target`. No-op if it's already marked/commented.
 * - `enabled: true` (resume): strip the marker to restore the original line.
 *   No-op if no marked line is present.
 *
 * ONLY the `WantedBy=` inside `[Install]` is touched: podman-systemd.unit(5)
 * honours WantedBy/RequiredBy/Alias only in `[Install]` to decide boot-start, so
 * a stray `WantedBy=` in another section is not a boot lever and must be left
 * alone — toggling it would let resume() falsely report success while the unit
 * stays unwired.
 *
 * Idempotent and reversible. Returns `changed: false` when the file is already
 * in the requested state (so callers can avoid a needless snapshot + reload).
 * Throws only when enabling and there is no `[Install] WantedBy=` line at all to
 * restore (a malformed Quadlet the updater never wrote).
 */
export function toggleBootStart(
  body: string,
  enabled: boolean,
): { body: string; changed: boolean } {
  const lines = body.split('\n');
  let changed = false;
  let sawWantedBy = false;
  let inInstall = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const section = line.match(SECTION_RE);
    if (section) {
      inInstall = section[1] === 'Install';
      continue;
    }
    if (!inInstall) continue;
    const m = line.match(WANTED_BY_RE);
    if (!m) continue;
    const indent = m[1] ?? '';
    const isMarked = m[2] !== undefined;
    const keyValue = m[3] ?? '';
    sawWantedBy = true;
    if (!enabled && !isMarked) {
      lines[i] = `${indent}${BOOT_START_MARKER}${keyValue}`;
      changed = true;
    } else if (enabled && isMarked) {
      lines[i] = `${indent}${keyValue}`;
      changed = true;
    }
  }
  if (enabled && !sawWantedBy) {
    throw new Error('WantedBy= line not found in Quadlet [Install] section');
  }
  return { body: lines.join('\n'), changed };
}

/**
 * Snapshot-then-rewrite the named Quadlet to enable/disable boot-start
 * (CC-1: snapshot first, atomic write, keep last 10). Mirrors
 * `rewriteQuadletImage`. Skips the write (and snapshot) when already in the
 * requested state. The caller still owns the daemon-reload + stop/start; this
 * only edits the file on disk.
 */
export async function setQuadletBootStart(
  quadletName: string,
  enabled: boolean,
): Promise<{ snapshotPath: string | null; changed: boolean }> {
  const filePath = join(QUADLET_DIR, quadletName);
  const original = await readQuadlet(quadletName);
  const { body, changed } = toggleBootStart(original, enabled);
  if (!changed) return { snapshotPath: null, changed: false };
  const snapshotPath = await snapshotQuadlet(quadletName);
  await writeAtomic(filePath, body);
  await pruneSnapshots(quadletName);
  return { snapshotPath, changed: true };
}

export async function readLastGood(): Promise<LastGood | null> {
  try {
    const body = await readFile(LAST_GOOD_PATH, 'utf8');
    return JSON.parse(body.toString()) as LastGood;
  } catch {
    return null;
  }
}

export async function writeLastGood(
  quadletName: string,
  entry: { tag: string; image: string; snapshotPath: string },
): Promise<void> {
  await mkdir(DOCTOR_DATA, { recursive: true });
  const existing = (await readLastGood()) ?? { updatedAt: '', quadlets: {} };
  existing.quadlets[quadletName] = entry;
  existing.updatedAt = new Date().toISOString();
  await writeAtomic(LAST_GOOD_PATH, JSON.stringify(existing, null, 2));
}

export function pathFor(quadletName: string): string {
  return join(QUADLET_DIR, quadletName);
}

export function snapshotDir(): string {
  return SNAPSHOT_DIR;
}

export { basename };
