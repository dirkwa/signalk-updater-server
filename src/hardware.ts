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

// Fixed on-board UARTs a detected board provides (HALPI2: /dev/ttyAMA4,
// RS-485), written host-side by detect-hardware.sh.
export interface OnboardSerialDevice {
  device: string;
  label?: string;
  enabled: boolean;
}

export interface HardwareJson {
  detectedAt?: string;
  serial: Omit<SerialDevice, 'kind'>[];
  can: Omit<CanDevice, 'kind'>[];
  bluetooth: Omit<BluetoothDevice, 'kind'>;
  gpio: Omit<GpioDevice, 'kind'>;
  socketcanCandidate?: SocketCanCandidate;
  onboardSerial?: OnboardSerialDevice[];
  // Classes this file does not model (audio, input, board, and any the
  // installer adds later) pass through readHardware and applyToHardware
  // unchanged, so an apply never deletes them from hardware.json.
  [key: string]: unknown;
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
    const raw: unknown = JSON.parse(body.toString());
    // Spread below, an array or a string would add its index keys ("0",
    // "1", ...) to the result, and an apply would write them back.
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ...EMPTY_HARDWARE };
    }
    const parsed = raw as Partial<HardwareJson>;
    return {
      ...parsed,
      serial: parsed.serial ?? [],
      can: parsed.can ?? [],
      bluetooth: parsed.bluetooth ?? EMPTY_HARDWARE.bluetooth,
      gpio: parsed.gpio ?? EMPTY_HARDWARE.gpio,
    };
  } catch {
    return { ...EMPTY_HARDWARE };
  }
}

export function applyToHardware(current: HardwareJson, req: HardwareApplyRequest): HardwareJson {
  const next: HardwareJson = {
    ...current,
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

// A serial path is passed only if it is made of characters that survive the
// unit file and the installer ExecStartPre's word split unchanged. Must match
// serial_devices_block in signalk-universal-installer's
// render-server-quadlet.sh, so an apply and a `signalk render-server` write
// the same lines.
const SAFE_DEVICE_PATH = /^\/[A-Za-z0-9._/:+@,=-]+$/;

// Lines of the HARDWARE block this file renders from hardware.json, or
// rendered in an earlier version (Volume=/dev/gpiomem). Every
// other line in the block (the /dev/snd, /dev/input, avahi and halpid
// Volume= lines and their comments) comes from host-side probes the
// installer's renderer runs and this container cannot repeat, so an apply
// carries those over from the live Quadlet instead of dropping them. A
// direct /run/dbus mount, written for bluetooth by older installers, counts
// as rendered here: carried next to the proxy's socket volume it would give
// podman two mounts at /run/dbus, and it would outlive bluetooth being off.
const RENDERED_HERE =
  /^(AddDevice=|Volume=signalk-dbus-socket:|Volume=\/run\/dbus[:/]|Volume=\/dev\/gpiomem:)/;

/** Enabled serial and onboardSerial device paths, in hardware.json order. */
function serialDevicePaths(hw: HardwareJson): string[] {
  return [
    ...hw.serial.filter((s) => s.enabled && s.byId).map((s) => s.byId),
    ...(hw.onboardSerial ?? []).filter((d) => d.enabled && d.device).map((d) => d.device),
  ];
}

export interface RenderOptions {
  /**
   * True when the Quadlet has the [Service] SERIAL DEVICES block (installer
   * templates since signalk-universal-installer#309): serial devices then go
   * there, through renderSerialDevicesBlock, and get no AddDevice= line here.
   */
  serialInService?: boolean;
  /** Lines of the live HARDWARE block not rendered here; see carriedHardwareLines. */
  carried?: string[];
  /**
   * True when the Quadlet's device ExecStartPre passes the GPIO nodes itself
   * (see passesGpioAtStart): enabled GPIO then goes into the SERIAL DEVICES
   * block as SIGNALK_GPIO=1 and gets no Volume= line here.
   */
  gpioInService?: boolean;
}

/**
 * Render the HARDWARE block (the `AddDevice=` / `Volume=` lines) from a
 * HardwareJson. Caller splices this between the BEGIN/END HARDWARE
 * comment markers in the Quadlet.
 *
 * CAN interfaces get no line: a SocketCAN interface is a network device with
 * no /dev node, signalk-server runs with Network=host, and an
 * AddDevice=/dev/can0 made every start fail (`stat /dev/can0: no such file or
 * directory`, exit 125).
 */
export function renderHardwareBlock(hw: HardwareJson, opts: RenderOptions = {}): string {
  const lines: string[] = [];
  if (!opts.serialInService) {
    // A Quadlet from before the SERIAL DEVICES block. Same lines the
    // installer's renderer wrote for it: a by-id path both mapped (the stable
    // name inside the container) and bare (podman resolves it to
    // /dev/ttyUSB0, the name existing configs use); an onboard UART once.
    // A path that fails SAFE_DEVICE_PATH would break the line, so it is left
    // out here too.
    for (const path of serialDevicePaths(hw)) {
      if (!SAFE_DEVICE_PATH.test(path)) continue;
      if (path.startsWith('/dev/serial/by-id/')) {
        lines.push(`AddDevice=${path}:${path}`, `AddDevice=${path}`);
      } else {
        lines.push(`AddDevice=${path}`);
      }
    }
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
  if (hw.gpio.enabled === true && !opts.gpioInService && hw.gpio.platform !== 'rpi5') {
    // A Quadlet whose ExecStartPre predates SIGNALK_GPIO. A Pi 5 gets no line:
    // it has /dev/gpiomem0..4 and no /dev/gpiomem, so this Volume= would fail
    // every start. `signalk render-server` brings the template that passes
    // the GPIO nodes at start.
    lines.push('Volume=/dev/gpiomem:/dev/gpiomem');
  }
  lines.push(...(opts.carried ?? []));
  return lines.join('\n');
}

/**
 * The [Service] SERIAL DEVICES block: one
 * `Environment="SIGNALK_SERIAL_DEVICES=<path> <path> ..."` line listing the
 * enabled serial and onboardSerial devices. The installer template's
 * ExecStartPre passes the ones present at each start to podman, so a device
 * missing at start no longer stops the server (signalk-universal-installer
 * #309). A path with characters the unit file would mangle is named in a
 * comment instead. With `gpioInService` and GPIO enabled it also holds
 * `Environment="SIGNALK_GPIO=1"`, after the serial list, so a Pi with GPIO
 * and no serial device still gets a non-empty block. Empty when nothing is
 * enabled.
 */
export function renderSerialDevicesBlock(
  hw: HardwareJson,
  opts: Pick<RenderOptions, 'gpioInService'> = {},
): string {
  const lines: string[] = [];
  const listed: string[] = [];
  for (const path of serialDevicePaths(hw)) {
    if (SAFE_DEVICE_PATH.test(path)) {
      listed.push(path);
    } else {
      lines.push(`# serial device not passed (unsupported characters): ${path}`);
    }
  }
  if (listed.length > 0) {
    lines.push(`Environment="SIGNALK_SERIAL_DEVICES=${listed.join(' ')}"`);
  }
  // `=== true`, like the installer's jq test: a string "true" in a
  // hand-edited hardware.json enables neither renderer.
  if (hw.gpio.enabled === true && opts.gpioInService) {
    lines.push('Environment="SIGNALK_GPIO=1"');
  }
  return lines.join('\n');
}

/** Lines between the given BEGIN/END markers, or null when the markers are absent. */
function blockLines(body: string, name: string): string[] | null {
  const lines = body.split('\n');
  const begin = lines.findIndex((l) => l.startsWith(`# === BEGIN ${name}`));
  if (begin < 0) return null;
  const end = lines.findIndex((l, i) => i > begin && l.startsWith(`# === END ${name}`));
  if (end < 0) return null;
  return lines.slice(begin + 1, end);
}

/**
 * Whether the Quadlet's device ExecStartPre passes the GPIO nodes present at
 * each start when SIGNALK_GPIO=1 (installer templates since
 * signalk-universal-installer's Pi 5 GPIO change). The GPIO nodes differ
 * between a Pi 4 (/dev/gpiomem) and a Pi 5 (/dev/gpiomem0..4), and a kernel
 * update renumbered the Pi 5's /dev/gpiochip*, so a Volume= written here
 * would fail the start whenever its node is missing.
 */
export function passesGpioAtStart(body: string): boolean {
  // Only an ExecStartPre= reads the flag; a comment, the Environment= line an
  // apply writes or any other directive naming it passes no device. The
  // command continues over lines ending in a backslash.
  const directives = body.replace(/\\\n/g, ' ').split('\n');
  return (
    hasSerialDevicesBlock(body) &&
    directives.some((d) => d.startsWith('ExecStartPre=') && d.includes('SIGNALK_GPIO'))
  );
}

/** Whether the Quadlet has the [Service] SERIAL DEVICES block. */
export function hasSerialDevicesBlock(body: string): boolean {
  return blockLines(body, 'SERIAL DEVICES') !== null;
}

/**
 * Non-empty lines of the live HARDWARE block that renderHardwareBlock does
 * not render, in their order, for `RenderOptions.carried`.
 */
export function carriedHardwareLines(body: string): string[] {
  return (blockLines(body, 'HARDWARE') ?? []).filter(
    (l) => l.trim() !== '' && !RENDERED_HERE.test(l),
  );
}

/**
 * Replace the content of the SERIAL DEVICES block. A Quadlet without the
 * block is returned unchanged; renderHardwareBlock covers it instead.
 */
export function spliceSerialDevicesBlock(body: string, block: string): string {
  if (!hasSerialDevicesBlock(body)) return body;
  const out: string[] = [];
  let inBlock = false;
  for (const line of body.split('\n')) {
    if (line.startsWith('# === BEGIN SERIAL DEVICES')) {
      out.push(line, block);
      inBlock = true;
      continue;
    }
    if (line.startsWith('# === END SERIAL DEVICES')) {
      inBlock = false;
      out.push(line);
      continue;
    }
    if (!inBlock) out.push(line);
  }
  return out.join('\n');
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
