// Hardware passthrough: read, mutate, render. The detection itself runs
// host-side (installer/linux/detect-hardware.sh from signalk-universal-
// installer) and writes ~/.signalk-updater/hardware.json which we mount
// at /data/hardware.json.
//
// This file owns the read+merge+render path. Re-detection from inside
// the container is documented as a future enhancement (Phase 10b);
// users on v1 re-run `~/.local/bin/signalk-recovery` SSH commands or
// rerun the bash installer to refresh the JSON.

import { readFile, writeFile, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const HARDWARE_PATH = process.env.HARDWARE_PATH ?? join(DATA_DIR, 'hardware.json');

export interface SerialDevice {
  kind: 'serial';
  byId: string;
  vendor?: string;
  product?: string;
  enabled: boolean;
}

export interface CanDevice {
  kind: 'can';
  interface: string;
  type: 'socketcan';
  enabled: boolean;
}

export interface BluetoothDevice {
  kind: 'bluetooth';
  dbusAvailable: boolean;
  enabled: boolean;
}

export interface GpioDevice {
  kind: 'gpio';
  platform: string;
  enabled: boolean;
}

// Written host-side by `signalk socketcan` (installer/linux/signalk-
// socketcan.tmpl in signalk-universal-installer). Read-only from the
// updater's perspective — the updater never mutates this field; it just
// surfaces it through GET /api/hardware so a future UI Hardware tab can
// render the candidate without reaching for the raw file.
export interface SocketCanCandidate {
  writtenAt: string;
  hat: string;
  displayName: string;
  configTxtOverlays: string[];
  bitrate: number;
  configApplied: boolean;
  ipLinkUp: boolean;
}

// Optional shared host charts folder. Set via `signalk charts <path>` (host-
// side, signalk-universal-installer) or /api/charts/apply. `hostPath` is the
// HOST directory the user shares with other chart apps (OpenCPN/qtVlm/…); the
// updater bind-mounts it at the fixed in-container target CHARTS_MOUNT_TARGET
// and exports SIGNALK_CHARTS_HOST_PATH so signalk-charts-provider-simple
// defaults to it. Stored here (not a separate file) to reuse the existing
// read/merge/render/atomic-write/snapshot machinery; it is NOT hardware, just a
// co-located managed mount.
export interface ChartsConfig {
  hostPath: string;
  enabled: boolean;
}

export interface HardwareJson {
  detectedAt?: string;
  serial: Omit<SerialDevice, 'kind'>[];
  can: Omit<CanDevice, 'kind'>[];
  bluetooth: Omit<BluetoothDevice, 'kind'>;
  gpio: Omit<GpioDevice, 'kind'>;
  socketcanCandidate?: SocketCanCandidate;
  charts?: ChartsConfig;
}

export interface HardwareApplyRequest {
  serial?: Array<{ byId: string; enabled: boolean }>;
  can?: Array<{ interface: string; enabled: boolean }>;
  bluetooth?: { enabled: boolean };
  gpio?: { enabled: boolean };
}

// The fixed in-container directory the host charts folder is bind-mounted at.
// signalk-charts-provider-simple reads SIGNALK_CHARTS_HOST_PATH (set to this)
// and defaults its chartPath here. A SIBLING of /home/node/.signalk — NOT
// nested under it: a bind nested inside the single ~/.signalk mount is invisible
// to signalk-backup/kopia (no mount-propagation handling), so charts would
// silently drop out of backups.
export const CHARTS_MOUNT_TARGET = '/home/node/charts-host';

const EMPTY_HARDWARE: HardwareJson = {
  serial: [],
  can: [],
  bluetooth: { dbusAvailable: false, enabled: false },
  gpio: { platform: 'none', enabled: false },
};

export async function readHardware(): Promise<HardwareJson> {
  try {
    const body = await readFile(HARDWARE_PATH, 'utf8');
    const parsed = JSON.parse(body.toString()) as Partial<HardwareJson>;
    return {
      detectedAt: parsed.detectedAt,
      serial: parsed.serial ?? [],
      can: parsed.can ?? [],
      bluetooth: parsed.bluetooth ?? EMPTY_HARDWARE.bluetooth,
      gpio: parsed.gpio ?? EMPTY_HARDWARE.gpio,
      socketcanCandidate: parsed.socketcanCandidate,
      charts: parsed.charts,
    };
  } catch {
    return { ...EMPTY_HARDWARE };
  }
}

export function applyToHardware(current: HardwareJson, req: HardwareApplyRequest): HardwareJson {
  const next: HardwareJson = {
    detectedAt: current.detectedAt,
    serial: current.serial.map((s) => {
      const override = req.serial?.find((r) => r.byId === s.byId);
      return override ? { ...s, enabled: override.enabled } : s;
    }),
    can: current.can.map((c) => {
      const override = req.can?.find((r) => r.interface === c.interface);
      return override ? { ...c, enabled: override.enabled } : c;
    }),
    bluetooth: {
      ...current.bluetooth,
      enabled: req.bluetooth?.enabled ?? current.bluetooth.enabled,
    },
    gpio: { ...current.gpio, enabled: req.gpio?.enabled ?? current.gpio.enabled },
    // Carry through fields this request doesn't touch — a hardware-apply must
    // not silently drop the charts mount or the socketcan candidate (both
    // were lost before because `next` only listed the fields it mutated).
    socketcanCandidate: current.socketcanCandidate,
    charts: current.charts,
  };
  return next;
}

/**
 * Merge a charts-folder change into a HardwareJson, carrying every other field
 * through untouched (same single-writer file as hardware-apply). `hostPath` is
 * the validated host directory; clearing it (enabled:false or empty path)
 * removes the managed CHARTS block on the next render.
 */
export function applyCharts(current: HardwareJson, charts: ChartsConfig): HardwareJson {
  return { ...current, charts };
}

async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export async function writeHardware(next: HardwareJson): Promise<void> {
  const tmp = `${HARDWARE_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o644 });
  const { rename } = await import('node:fs/promises');
  await rename(tmp, HARDWARE_PATH);
  await fsyncDir(dirname(HARDWARE_PATH));
}

/**
 * Render the HARDWARE block (the `AddDevice=` / `Volume=` lines) from a
 * HardwareJson. Caller splices this between the BEGIN/END HARDWARE
 * comment markers in the Quadlet.
 */
export function renderHardwareBlock(hw: HardwareJson): string {
  const lines: string[] = [];
  for (const s of hw.serial) {
    if (s.enabled && s.byId) lines.push(`AddDevice=${s.byId}`);
  }
  for (const c of hw.can) {
    if (c.enabled && c.interface) lines.push(`AddDevice=/dev/${c.interface}`);
  }
  if (hw.bluetooth.enabled && hw.bluetooth.dbusAvailable) {
    lines.push('Volume=/run/dbus:/run/dbus:ro');
  }
  if (hw.gpio.enabled) {
    lines.push('Volume=/dev/gpiomem:/dev/gpiomem');
  }
  return lines.join('\n');
}

/**
 * Splice a freshly-rendered HARDWARE block into a Quadlet body, replacing
 * any existing content between the BEGIN HARDWARE / END HARDWARE markers.
 * If the markers are absent, append them with the new block at the end.
 */
export function spliceHardwareBlock(body: string, block: string): string {
  const beginRe = /^# === BEGIN HARDWARE/m;
  const endRe = /^# === END HARDWARE/m;
  if (!beginRe.test(body) || !endRe.test(body)) {
    return `${body.trimEnd()}\n\n# === BEGIN HARDWARE (managed by signalk-universal-installer) ===\n${block}\n# === END HARDWARE ===\n`;
  }
  const lines = body.split('\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (beginRe.test(line)) {
      out.push(line);
      out.push(block);
      inBlock = true;
      continue;
    }
    if (endRe.test(line)) {
      inBlock = false;
      out.push(line);
      continue;
    }
    if (!inBlock) out.push(line);
  }
  return out.join('\n');
}

/**
 * Render the CHARTS block: the `Volume=` bind for the shared host charts folder
 * plus the `Environment=SIGNALK_CHARTS_HOST_PATH=` line the plugin reads. Empty
 * when charts is unset/disabled or the host path is blank (the mount then
 * disappears on the next render, same as a disabled device).
 *
 * NO `:Z`/`:z` relabel suffix: `:Z` would give the bind a container-PRIVATE
 * SELinux label that blocks the host user's GUI / OpenCPN / qtVlm from
 * read-writing the same shared folder; on non-SELinux hosts any suffix is a
 * no-op. Matches the template's no-relabel precedent for shared host mounts.
 * The bind is read-write (no `:ro`): the plugin downloads/renames/deletes/
 * converts charts in this folder.
 */
export function renderChartsBlock(hw: HardwareJson): string {
  const charts = hw.charts;
  if (!charts || !charts.enabled || charts.hostPath.trim() === '') {
    return '';
  }
  const hostPath = charts.hostPath.trim();
  return [
    `Volume=${hostPath}:${CHARTS_MOUNT_TARGET}`,
    `Environment=SIGNALK_CHARTS_HOST_PATH=${CHARTS_MOUNT_TARGET}`,
  ].join('\n');
}

const CHARTS_BEGIN = '# === BEGIN CHARTS (managed by signalk-universal-installer) ===';
const CHARTS_END = '# === END CHARTS ===';

/**
 * Splice a freshly-rendered CHARTS block into a Quadlet body.
 *
 * - If the CHARTS markers already exist (Phase-3+ template), replace the content
 *   between them.
 * - If they DON'T exist yet (this updater released before the installer template
 *   ships them), insert a fresh CHARTS block immediately AFTER the
 *   `# === END HARDWARE ===` marker. That marker is present on every install and
 *   sits inside the `[Container]` section — which is the ONLY safe place for the
 *   `Volume=`/`Environment=` lines. (Appending at EOF would land them after
 *   `[Install]`, where podman's Quadlet generator silently ignores them — a
 *   verified silent-no-mount bug, since the keys are parsed under `[Install]`.)
 * - If NEITHER marker set exists (a hand-mangled or pre-managed Quadlet), throw
 *   rather than guess a section and risk a silent no-mount.
 */
export function spliceChartsBlock(body: string, block: string): string {
  const beginRe = /^# === BEGIN CHARTS/m;
  const endRe = /^# === END CHARTS/m;
  const hardwareEndRe = /^# === END HARDWARE/m;

  // Markers present: replace between them.
  if (beginRe.test(body) && endRe.test(body)) {
    const lines = body.split('\n');
    const out: string[] = [];
    let inBlock = false;
    for (const line of lines) {
      if (beginRe.test(line)) {
        out.push(line);
        out.push(block);
        inBlock = true;
        continue;
      }
      if (endRe.test(line)) {
        inBlock = false;
        out.push(line);
        continue;
      }
      if (!inBlock) out.push(line);
    }
    return out.join('\n');
  }

  // No CHARTS markers yet: anchor a fresh block after the END HARDWARE marker so
  // the keys land inside [Container], not after [Install].
  if (hardwareEndRe.test(body)) {
    const lines = body.split('\n');
    const out: string[] = [];
    for (const line of lines) {
      out.push(line);
      if (hardwareEndRe.test(line)) {
        out.push('');
        out.push(CHARTS_BEGIN);
        out.push(block);
        out.push(CHARTS_END);
      }
    }
    return out.join('\n');
  }

  throw new Error(
    'cannot place CHARTS block: neither CHARTS nor HARDWARE markers found in the Quadlet',
  );
}

/**
 * Advisory lexical safety check on a host charts path. This is DEFENSE IN DEPTH,
 * not the authoritative gate: the updater runs in a userns'd container and
 * cannot stat an unmounted host path, so the real validation (realpath,
 * ownership, fs-type, exists-is-dir) is host-side in the `signalk charts` CLI
 * and re-run at render time in render-server-quadlet.sh. We re-assert the
 * lexical deny-list here because the plugin-console proxy backfills the engine
 * bearer for all /api/* and cannot be trusted to have validated the path.
 *
 * Rejects: non-absolute paths; `..` traversal; and paths that ARE or are UNDER
 * a sensitive system/home location. Returns null when acceptable, else a reason.
 */
export function validateChartsHostPathLexical(rawPath: string): string | null {
  const p = rawPath.trim();
  if (p === '') return 'path must not be empty';
  if (!p.startsWith('/')) return 'path must be absolute';
  // Reject ALL control characters (incl. NUL, newline, CR). This is the trust
  // boundary for the plugin-console proxy, and renderChartsBlock interpolates
  // the path straight into a `Volume=` line — a newline would split it and let
  // a caller inject an arbitrary Quadlet directive into [Container]. A control
  // char is never legitimate in a chart-folder path.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return 'path must not contain control characters';
  // A `:` in the host path would corrupt the `Volume=<host>:<target>` parse
  // (podman would mis-split source/target/options). `:` is legal in a Linux
  // filename but never wanted in a chart-folder path, so reject it.
  if (p.includes(':')) return 'path must not contain ":"';
  // Reject any `..` segment outright (we do not resolve here — that is host-
  // side; lexically any `..` is suspicious for a mount target).
  if (p.split('/').some((seg) => seg === '..')) return 'path must not contain ".."';

  // Collapse duplicate slashes + a trailing slash for prefix checks. Compare
  // case-INSENSITIVELY: Linux is case-sensitive so /ETC != /etc as real paths,
  // but this advisory deny-list refuses "secrets-shaped" paths regardless of
  // case (and a case-insensitive fs like a vfat USB stick would treat them as
  // the same dir). Lower-case once for all the prefix/regex checks below.
  const norm = (p.replace(/\/+/g, '/').replace(/\/$/, '') || '/').toLowerCase();

  // The filesystem root itself is never a valid mount target.
  if (norm === '/') return 'path must not be the filesystem root';

  // Deny if the path IS, or is a descendant of, any of these roots. (`/` is NOT
  // in this list — every absolute path is "under" it; the exact-root case is
  // handled above.)
  const denyRoots = [
    '/etc',
    '/proc',
    '/sys',
    '/dev',
    '/boot',
    '/usr',
    '/bin',
    '/sbin',
    '/lib',
    '/lib64',
    '/var',
    '/root',
    '/run',
  ];
  for (const root of denyRoots) {
    if (norm === root || norm.startsWith(`${root}/`)) {
      // /run is denied except the /run/media carve-out (removable drives).
      if (root === '/run' && (norm === '/run/media' || norm.startsWith('/run/media/'))) {
        continue;
      }
      return `path must not be under ${root}`;
    }
  }
  // Deny SK's own config/secret dirs even when they live under an allowed home.
  // (`norm` is already lower-cased above, so these match any case.)
  if (
    /(^|\/)\.signalk(-[^/]*)?(\/|$)/.test(norm) ||
    /(^|\/)\.(ssh|config|gnupg)(\/|$)/.test(norm)
  ) {
    return 'path must not be inside a Signal K data or secrets directory';
  }
  return null;
}
