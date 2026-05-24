import type { FastifyInstance } from 'fastify';
import { rewriteQuadletImage } from '../quadlet/rewriter.js';
import { daemonReload, restartUnit } from '../dbus/systemd-user.js';
import { withMutex, MutexBusyError } from '../mutex.js';
import { requireToken } from '../auth.js';
import { listTags } from '../ghcr.js';
import { resolveRuntime, safe } from '../podman/client.js';

const SELF_IMAGE = process.env.SELF_IMAGE ?? 'ghcr.io/dirkwa/signalk-updater-server';
const SELF_QUADLET = 'signalk-updater-server.container';
const SELF_UNIT = 'signalk-updater-server.service';

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
          // Rewrite own Quadlet so the next start picks up the new image.
          await rewriteQuadletImage(SELF_QUADLET, newImage);
          // daemon-reload so systemd re-reads the generated unit file.
          // The actual restart is fired AFTER the HTTP response flushes
          // (see below) so the client gets the OK reply first.
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
      // Send the response BEFORE asking systemd to restart us — once
      // restartUnit() fires, podman is going to SIGTERM our process
      // mid-call and the socket dies. The 500ms grace gives the
      // kernel time to flush the TCP buffer.
      //
      // We use systemctl restart (via DBus) rather than a clean
      // self-exit. The previous design exited zero and relied on
      // Restart=on-failure to bring us back, but Restart=on-failure
      // ignores zero exit codes — the unit just goes inactive(dead)
      // and never restarts.
      // (See the 2026-05-24T17:19 incident: clean exit, no restart.)
      // restartUnit triggers systemd unconditionally regardless of
      // Restart=, so it works with the CC-4-mandated on-failure policy.
      reply.send({ ok: true, from: state, to: tag, exiting: true });
      setTimeout(() => {
        // Best-effort: if the DBus call itself fails, log and exit so
        // operator notices via the dead unit; the Quadlet is already
        // pointing at the new image, so a manual `systemctl --user start`
        // will bring it up correctly.
        restartUnit(SELF_UNIT).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`self-update: restartUnit failed: ${msg}`);
          process.exit(1);
        });
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
