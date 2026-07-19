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

export interface HardwareJson {
  detectedAt?: string;
  serial: Omit<SerialDevice, 'kind'>[];
  can: Omit<CanDevice, 'kind'>[];
  bluetooth: Omit<BluetoothDevice, 'kind'>;
  gpio: Omit<GpioDevice, 'kind'>;
  socketcanCandidate?: SocketCanCandidate;
}

export interface HardwareApplyRequest {
  serial?: Array<{ byId: string; enabled: boolean }>;
  can?: Array<{ interface: string; enabled: boolean }>;
  bluetooth?: { enabled: boolean };
  gpio?: { enabled: boolean };
}

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
  };
  return next;
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
    // The signalk-dbus-proxy sidecar's named socket volume, NOT a direct
    // /run/dbus bind mount. D-Bus EXTERNAL auth compares the uid the
    // in-container client sends against the kernel's SO_PEERCRED; across
    // the rootless userns those differ on any host whose SignalK user
    // isn't uid 1000, so a direct mount never authenticates and BLE
    // plugins die with "closed stream". The proxy rewrites the AUTH uid
    // in transit. Must match the installer's render-server-quadlet.sh
    // bluetooth clause — an apply that emitted the old bind mount here
    // would silently regress a working `signalk bluetooth enable`.
    lines.push('Volume=signalk-dbus-socket:/run/dbus:rw');
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
