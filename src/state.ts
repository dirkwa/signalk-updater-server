import type { ContainerSnapshot, CurrentState } from './types.js';
import { resolveRuntime } from './podman/client.js';

const CONTAINERS = {
  signalkServer: 'signalk-server',
  updaterServer: 'signalk-updater-server',
  doctorServer: 'signalk-doctor-server',
} as const;

function snapshotFromInspect(info: {
  Image?: string;
  ImageName?: string;
  State?: { Status?: string; Running?: boolean; StartedAt?: string };
  Created?: string;
}): ContainerSnapshot {
  const image = info.ImageName ?? info.Image ?? '';
  const tag = image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : image || 'unknown';
  const stateStr = (info.State?.Status ?? 'missing').toLowerCase();
  const state: ContainerSnapshot['state'] =
    stateStr === 'running'
      ? 'running'
      : stateStr === 'created' || stateStr === 'restarting' || stateStr === 'starting'
        ? 'starting'
        : stateStr === 'exited' || stateStr === 'stopped' || stateStr === 'dead'
          ? 'stopped'
          : stateStr === 'unhealthy'
            ? 'unhealthy'
            : 'missing';
  return {
    tag,
    digest: '', // populated by inspectDigest below
    state,
    startedAt: info.State?.StartedAt ?? info.Created,
  };
}

async function inspectOne(name: string): Promise<ContainerSnapshot> {
  const rt = await resolveRuntime();
  if (!rt) {
    return { tag: 'unknown', digest: '', state: 'missing' };
  }
  try {
    const c = rt.client.getContainer(name);
    const info = (await c.inspect()) as unknown as {
      Image?: string;
      ImageName?: string;
      State?: { Status?: string; Running?: boolean; StartedAt?: string };
      Created?: string;
    };
    const snap = snapshotFromInspect(info);
    try {
      const img = await rt.client.getImage(info.Image ?? info.ImageName ?? '').inspect();
      const digestField = (img as unknown as { RepoDigests?: string[] }).RepoDigests?.[0] ?? '';
      snap.digest = digestField.includes('@')
        ? digestField.slice(digestField.indexOf('@') + 1)
        : '';
    } catch {
      // image gone or not inspectable; leave digest empty
    }
    return snap;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no such container/i.test(msg) || /404/i.test(msg)) {
      return { tag: 'unknown', digest: '', state: 'missing' };
    }
    return { tag: 'unknown', digest: '', state: 'missing' };
  }
}

export async function getCurrentState(): Promise<CurrentState> {
  const [sk, up, doc] = await Promise.all([
    inspectOne(CONTAINERS.signalkServer),
    inspectOne(CONTAINERS.updaterServer),
    inspectOne(CONTAINERS.doctorServer),
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
