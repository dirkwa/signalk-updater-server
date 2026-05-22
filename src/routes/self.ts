import type { FastifyInstance } from 'fastify';
import { rewriteQuadletImage } from '../quadlet/rewriter.js';
import { daemonReload } from '../dbus/systemd-user.js';
import { withMutex, MutexBusyError } from '../mutex.js';
import { requireToken } from '../auth.js';
import { listTags } from '../ghcr.js';
import { resolveRuntime, safe } from '../podman/client.js';

const SELF_IMAGE = process.env.SELF_IMAGE ?? 'ghcr.io/dirkwa/signalk-updater-server';
const SELF_QUADLET = 'signalk-updater-server.container';

interface SelfState {
  currentTag: string;
  availableTag?: string;
  updateAvailable: boolean;
}

async function readSelfTag(): Promise<string> {
  const rt = await resolveRuntime();
  if (!rt) return 'unknown';
  try {
    const c = rt.client.getContainer('signalk-updater-server');
    const info = (await c.inspect()) as unknown as { Image?: string; ImageName?: string };
    const image = info.ImageName ?? info.Image ?? '';
    return image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function registerSelfRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/self/state', async (): Promise<SelfState> => {
    const current = await readSelfTag();
    const r = await listTags(SELF_IMAGE.replace(/^ghcr\.io\//, ''));
    if (!r.ok) {
      return { currentTag: current, updateAvailable: false };
    }
    const stable = r.tags.filter((t) => t.channel === 'stable');
    stable.sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
    const latest = stable[0]?.name;
    return {
      currentTag: current,
      availableTag: latest,
      updateAvailable: latest !== undefined && latest !== current,
    };
  });

  app.post<{ Body: { tag?: string } }>(
    '/api/self/update',
    { preHandler: requireToken },
    async (req, reply) => {
      const target = req.body?.tag;
      const state = await readSelfTag();
      const tag = target ?? (await deriveLatest());
      if (!tag) {
        reply.code(400);
        return { error: 'no target tag available' };
      }
      try {
        await withMutex('self-update', async () => {
          const newImage = `${SELF_IMAGE}:${tag}`;
          // Pull first
          const rt = await resolveRuntime();
          if (!rt) throw new Error('runtime unreachable');
          const pull = await safe(
            () =>
              new Promise<void>((resolve, reject) => {
                rt.client.pull(newImage, {}, (err, stream) => {
                  if (err) return reject(err);
                  if (!stream) return resolve();
                  rt.client.modem.followProgress(
                    stream,
                    (e) => (e ? reject(e) : resolve()),
                    () => undefined,
                  );
                });
              }),
          );
          if (!pull.ok) throw new Error(`pull failed: ${pull.error.userMessage}`);
          // Rewrite own Quadlet
          await rewriteQuadletImage(SELF_QUADLET, newImage);
          // daemon-reload, then schedule self-exit so systemd picks up the new unit and restarts us.
          await daemonReload();
        });
      } catch (err) {
        if (err instanceof MutexBusyError) {
          reply.code(409);
          return { error: err.message, lock: err.lock };
        }
        reply.code(500);
        return { error: err instanceof Error ? err.message : 'unknown error' };
      }
      // Schedule exit AFTER the response is flushed. systemd's Restart=on-failure
      // will restart us on the new tag (Quadlet now references the new image).
      reply.send({ ok: true, from: state, to: tag, exiting: true });
      setTimeout(() => {
        process.exit(0);
      }, 500);
      return reply;
    },
  );
}

async function deriveLatest(): Promise<string | null> {
  const r = await listTags(SELF_IMAGE.replace(/^ghcr\.io\//, ''));
  if (!r.ok) return null;
  const stable = r.tags.filter((t) => t.channel === 'stable');
  stable.sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
  return stable[0]?.name ?? null;
}
