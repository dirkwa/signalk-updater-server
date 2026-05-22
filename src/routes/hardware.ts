import type { FastifyInstance } from 'fastify';
import { readFile, open, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  applyToHardware,
  readHardware,
  renderHardwareBlock,
  spliceHardwareBlock,
  writeHardware,
  type HardwareApplyRequest,
} from '../hardware.js';
import { withMutex, MutexBusyError } from '../mutex.js';
import { snapshotQuadlet, pruneSnapshots } from '../quadlet/rewriter.js';
import { daemonReload, restartUnit } from '../dbus/systemd-user.js';
import { safe } from '../podman/client.js';
import { requireToken } from '../auth.js';

const QUADLET_DIR = process.env.QUADLET_DIR ?? '/quadlets';
const SERVER_QUADLET = 'signalk-server.container';
const SERVER_UNIT = 'signalk-server.service';
const SIGNALK_HEALTH_URL = process.env.SIGNALK_HEALTH_URL ?? 'http://127.0.0.1:3000/signalk';

async function fsyncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function writeAtomic(path: string, body: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  const fh = await open(tmp, 'w', 0o644);
  try {
    await fh.write(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
  await fsyncDir(dirname(path));
}

async function pollHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // ignore
    }
    await delay(2000);
  }
  return false;
}

export async function registerHardwareRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/hardware', async () => readHardware());

  app.post<{ Body: HardwareApplyRequest }>(
    '/api/hardware/apply',
    { preHandler: requireToken },
    async (req, reply) => {
      try {
        return await withMutex('hardware-apply', async () => {
          const current = await readHardware();
          const next = applyToHardware(current, req.body ?? {});
          await writeHardware(next);

          // Rewrite the server Quadlet with the new HARDWARE block.
          const quadletPath = join(QUADLET_DIR, SERVER_QUADLET);
          const original = (await readFile(quadletPath, 'utf8')).toString();
          await snapshotQuadlet(SERVER_QUADLET);
          const block = renderHardwareBlock(next);
          const rewritten = spliceHardwareBlock(original, block);
          await writeAtomic(quadletPath, rewritten);
          await pruneSnapshots(SERVER_QUADLET);

          // daemon-reload + restart signalk-server
          const dbusOk = await safe(async () => {
            await daemonReload();
            await restartUnit(SERVER_UNIT);
          });
          if (!dbusOk.ok) {
            return { ok: false, error: `systemd: ${dbusOk.error.userMessage}` };
          }

          const healthy = await pollHealth(SIGNALK_HEALTH_URL, 120000);
          return {
            ok: healthy,
            hardware: next,
            error: healthy ? undefined : 'signalk-server did not return to health within 120s',
          };
        });
      } catch (err) {
        if (err instanceof MutexBusyError) {
          reply.code(409);
          return { error: err.message, lock: err.lock };
        }
        reply.code(500);
        return { error: err instanceof Error ? err.message : 'unknown error' };
      }
    },
  );
}
