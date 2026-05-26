// systemd user-bus client for `daemon-reload` + `restart <unit>`.
//
// Uses systemd's own `busctl` CLI (shipped by the `systemd` apt package
// in the ubuntu/debian base image) rather than the @homebridge/dbus-
// native JS lib. Rationale: dbus-native sends process.getuid() in
// EXTERNAL auth, which inside a rootless-podman userns is 0 (in-container
// root), while the host bus daemon expects the SCM_CREDENTIALS uid (the
// host user). They don't match and the handshake is rejected. busctl
// handles this correctly because it negotiates with the kernel's
// credentials view, not its own getuid().
//
// The session bus address is set by the container Quadlet via:
//   Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/host/dbus
//
// CLI surface is tiny (three methods on systemd1.Manager) so the
// shell-out cost is dwarfed by the latency of the subsequent container
// restart anyway.

import { spawn } from 'node:child_process';

const SYSD = {
  bus: 'org.freedesktop.systemd1',
  obj: '/org/freedesktop/systemd1',
  iface: 'org.freedesktop.systemd1.Manager',
} as const;

function busAddress(): string {
  const addr = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (!addr) throw new Error('DBUS_SESSION_BUS_ADDRESS not set');
  return addr;
}

interface BusctlResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runBusctl(args: string[], timeoutMs = 30_000): Promise<BusctlResult> {
  return new Promise((resolve) => {
    const fullArgs = ['--user', `--address=${busAddress()}`, ...args];
    const child = spawn('busctl', fullArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok: false, stdout, stderr: stderr + '\n[busctl: timed out]', exitCode: null });
    }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve({ ok: code === 0, stdout, stderr, exitCode: code });
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve({ ok: false, stdout, stderr: stderr + err.message, exitCode: null });
    });
  });
}

async function call(method: string, signature = '', args: string[] = []): Promise<void> {
  const r = await runBusctl(['call', SYSD.bus, SYSD.obj, SYSD.iface, method, signature, ...args]);
  if (!r.ok) {
    throw new Error(`busctl ${method} failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
  }
}

export async function daemonReload(): Promise<void> {
  await call('Reload');
}

export async function restartUnit(unit: string): Promise<void> {
  await call('RestartUnit', 'ss', [unit, 'replace']);
}

export async function startUnit(unit: string): Promise<void> {
  await call('StartUnit', 'ss', [unit, 'replace']);
}

export async function stopUnit(unit: string): Promise<void> {
  await call('StopUnit', 'ss', [unit, 'replace']);
}

/**
 * Read `org.freedesktop.systemd1.Unit.ActiveState` for the named unit.
 * Returns one of systemd's documented states: `active`, `reloading`,
 * `inactive`, `failed`, `activating`, `deactivating`. Returns `unknown`
 * if the unit doesn't exist or the property can't be read.
 */
export async function getActiveState(unit: string): Promise<string> {
  const r = await runBusctl([
    'get-property',
    SYSD.bus,
    `${SYSD.obj}/unit/${encodeUnitPath(unit)}`,
    'org.freedesktop.systemd1.Unit',
    'ActiveState',
  ]);
  if (!r.ok) return 'unknown';
  // Output shape: `s "active"\n`
  const m = /"([^"]+)"/.exec(r.stdout);
  return m?.[1] ?? 'unknown';
}

/**
 * systemd encodes unit names in object paths by replacing every non-[A-Za-z0-9]
 * character with `_<hex>` (e.g. `signalk-server.service` →
 * `signalk_2dserver_2eservice`). Mirrors `bus_path_escape` in systemd.
 */
function encodeUnitPath(unit: string): string {
  return unit.replace(/[^A-Za-z0-9]/g, (c) => `_${c.charCodeAt(0).toString(16)}`);
}

/**
 * Stop a unit and wait for it to reach a terminal state (`inactive` or
 * `failed`). `stopUnit` only enqueues the stop job — when we follow it
 * with `startUnit`, the two are independent DBus jobs and systemd does
 * NOT serialize them. Polling ActiveState bridges that gap so the
 * caller can assume the unit is fully down before issuing the next
 * start. Times out after `timeoutMs` (default 30s, which is generous
 * for a 10s SIGTERM grace + container teardown).
 */
export async function stopUnitAndWait(unit: string, timeoutMs = 30_000): Promise<void> {
  await stopUnit(unit);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getActiveState(unit);
    if (state === 'inactive' || state === 'failed' || state === 'unknown') return;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`stopUnit(${unit}) did not reach terminal state within ${timeoutMs}ms`);
}
