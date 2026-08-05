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

/**
 * Clear a unit's `failed` state — the DBus equivalent of
 * `systemctl --user reset-failed <unit>`. Needed before starting
 * signalk-server: on Quadlets rendered before signalk-universal-installer
 * #235 dropped the start-limit guard, five starts in 30 minutes park the
 * unit in `failed (start-limit-hit)` and systemd then refuses every start
 * request until the latch is cleared. Crucially, `StartUnit` does NOT
 * surface the refusal — the DBus call only enqueues a job and returns
 * success; the job is what gets refused. A no-op on a unit that is not
 * failed.
 */
export async function resetFailedUnit(unit: string): Promise<void> {
  await call('ResetFailedUnit', 's', [unit]);
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
 * Is it safe to STOP a unit sitting in this ActiveState?
 *
 * Deliberately an ALLOWLIST of states that prove the start is over, not
 * "anything except activating". `getActiveState` returns `unknown` whenever the
 * busctl call itself fails, so a transient DBus hiccup during a switch would
 * otherwise read as permission to stop a unit that is still mid-container-
 * create — the precise sequence that SIGKILLs `podman run` and wedges the
 * host's c/storage lock. Any future systemd state we do not recognise lands on
 * the cautious side for the same reason.
 *
 * `active` counts as settled: the start finished, nothing is mid-create, and
 * stopping it is exactly what the normal switch path already does. Only
 * `activating` (create possibly in flight) and `unknown` (we cannot tell) are
 * off limits.
 *
 * The asymmetry justifies the caution: leaving a bad image running is
 * recoverable from the Doctor Console or `signalk-recovery`, while a wedged
 * podman needs SSH. When the state is not provably settled, do not stop.
 *
 * NOTE: this answers about a state you have JUST read. An ActiveState goes
 * stale the moment you stop looking at it — with `Restart=always` a
 * crashlooping unit cycles back into `activating` within RestartSec — so
 * re-read immediately before acting rather than reusing an earlier answer
 * across a long await.
 */
export function isSafeToStop(state: string): boolean {
  return (
    state === 'active' || state === 'failed' || state === 'inactive' || state === 'deactivating'
  );
}

/**
 * Block while a unit is still `activating`, resolving once it settles (or the
 * deadline passes). Returns the final ActiveState.
 *
 * Call this before stopping a unit you did not just watch start. `startUnit`
 * only ENQUEUES a job — it returns when systemd accepts the request, not when
 * the unit is up — so a health poll runs concurrently with systemd's own start
 * budget rather than after it. signalk-server's Quadlet allows
 * TimeoutStartSec=300 for a slow SD-card container create, which outlasts
 * DEFAULT_HEALTH_TIMEOUT_MS; the poll can therefore expire while the start is
 * still perfectly legal.
 *
 * Stopping a unit in that window is what makes this dangerous rather than
 * merely wrong: systemd SIGTERMs `podman run` mid-container-create and SIGKILLs
 * it at TimeoutStopSec. The half-written container layer survives as an
 * `incomplete` layer whose overlayfs mount is still live, podman's own cleanup
 * spins on it holding the global c/storage lock, and every later podman command
 * blocks — the host needs `signalk-recovery unwedge-podman` over SSH. Waiting
 * for the unit to settle keeps a failed switch a failed switch.
 *
 * Default 330s clears the 300s TimeoutStartSec the installer renders, so a
 * create that is merely slow is never mistaken for a hung one.
 *
 * `readState` exists as an explicit test seam. `vi.mock` on this module's
 * exports cannot intercept an intra-module call — the loop would keep using the
 * real `getActiveState` and quietly query the host's systemd — so the reader is
 * injected rather than closed over. Production callers pass nothing.
 */
export async function waitWhileActivating(
  unit: string,
  timeoutMs = 330_000,
  readState: (u: string) => Promise<string> = getActiveState,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let state = await readState(unit);
  while (state === 'activating' && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    state = await readState(unit);
  }
  return state;
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
