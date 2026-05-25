import type { ContainerSnapshot, CurrentState } from './types.js';
import { resolveRuntime } from './podman/client.js';
import { getRuntimeIdentity, type VersionTarget } from './runtime-version.js';
import { readQuadletImageTag } from './quadlet-image-tag.js';
import { getSelfVersion } from './routes/health.js';

// Per-container targets for the RuntimeIdentity resolver. Quadlet names
// are static (the installer drops them under ~/.config/containers/systemd
// with these exact basenames). The updater reads its own version via
// `getSelfVersion` (cached package.json) rather than a self-HTTP probe.
// The doctor's health URL goes via host loopback because we share the
// host network namespace through the rootless podman socket mount.
const SIGNALK_TARGET: VersionTarget = {
  container: 'signalk-server',
  quadletName: 'signalk-server.container',
  // signalk-server's /signalk endpoint isn't a `{version}` shape we
  // own. Falls through to image-label / Quadlet tag. With the default
  // `:dirkwa` Quadlet, version is null and channel is 'dirkwa' — the
  // honest answer the UI displays as the channel name.
};

const UPDATER_TARGET: VersionTarget = {
  container: 'signalk-updater-server',
  quadletName: 'signalk-updater-server.container',
  selfVersion: getSelfVersion,
};

const DOCTOR_TARGET: VersionTarget = {
  container: 'signalk-doctor-server',
  quadletName: 'signalk-doctor-server.container',
  healthUrl: process.env.DOCTOR_HEALTH_URL ?? 'http://127.0.0.1:3004/api/health',
};

function classifyState(status: string | undefined): ContainerSnapshot['state'] {
  const s = (status ?? 'missing').toLowerCase();
  if (s === 'running') return 'running';
  if (s === 'created' || s === 'restarting' || s === 'starting') return 'starting';
  if (s === 'exited' || s === 'stopped' || s === 'dead') return 'stopped';
  if (s === 'unhealthy') return 'unhealthy';
  return 'missing';
}

async function inspectOne(target: VersionTarget): Promise<ContainerSnapshot> {
  const identity = await getRuntimeIdentity(target);
  const tag = await readQuadletImageTag(target.quadletName);

  const rt = await resolveRuntime();
  if (!rt) {
    return {
      tag,
      digest: '',
      version: identity.version,
      channel: identity.channel,
      state: 'missing',
    };
  }

  try {
    const c = rt.client.getContainer(target.container);
    const info = (await c.inspect()) as unknown as {
      Image?: string;
      ImageName?: string;
      State?: { Status?: string; Running?: boolean; StartedAt?: string };
      Created?: string;
    };
    let digest = '';
    try {
      const img = await rt.client.getImage(info.Image ?? info.ImageName ?? '').inspect();
      const digestField = (img as unknown as { RepoDigests?: string[] }).RepoDigests?.[0] ?? '';
      digest = digestField.includes('@') ? digestField.slice(digestField.indexOf('@') + 1) : '';
    } catch {
      // image gone or not inspectable; leave digest empty
    }
    return {
      tag,
      digest,
      version: identity.version,
      channel: identity.channel,
      state: classifyState(info.State?.Status),
      startedAt: info.State?.StartedAt ?? info.Created,
    };
  } catch {
    // Both "no such container" and other inspect failures produce the
    // same shape — the container is effectively missing either way for
    // the purposes of the Dashboard's status indicator.
    return {
      tag,
      digest: '',
      version: identity.version,
      channel: identity.channel,
      state: 'missing',
    };
  }
}

export async function getCurrentState(): Promise<CurrentState> {
  const [sk, up, doc] = await Promise.all([
    inspectOne(SIGNALK_TARGET),
    inspectOne(UPDATER_TARGET),
    inspectOne(DOCTOR_TARGET),
  ]);
  return {
    signalkServer: sk,
    updaterServer: { ...up, updateAvailable: false },
    doctorServer: doc,
    lastCheck: new Date().toISOString(),
  };
}

export async function tailContainerLogs(name: string, lines: number): Promise<string> {
  const rt = await resolveRuntime();
  if (!rt) return '';
  try {
    const c = rt.client.getContainer(name);
    const buf = (await c.logs({
      stdout: true,
      stderr: true,
      tail: String(lines) as unknown as number,
      timestamps: false,
    })) as Buffer | string;
    // dockerode returns a multiplexed stream when stdout+stderr+follow=false; we read as buffer.
    if (Buffer.isBuffer(buf)) {
      return buf.toString('utf8');
    }
    return String(buf);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[doctor: cannot read logs for ${name}: ${msg}]`;
  }
}
