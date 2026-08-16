import type { FastifyInstance } from 'fastify';
import { requireToken } from '../auth.js';
import {
  deleteArchive,
  isValidArchiveName,
  listArchives,
  loadArchive,
  pickArchiveRef,
} from '../local-archives.js';
import { resolveSignalkImage } from '../signalk-image.js';
import { performSwitch } from '../switch-service.js';
import { withMutex, MutexBusyError } from '../mutex.js';
import { publishSwitchEvent } from '../switch-progress-broker.js';
import type { ArchivesResponse } from '../types.js';

interface MinimalLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

const fmtBytes = (n: number): string =>
  n >= 1024 * 1024 * 1024
    ? `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
    : `${Math.round(n / (1024 * 1024))} MB`;

/**
 * Background `podman load` under the shared mutex, streamed over the switch
 * broker as `loading` → `complete`/`failed`. Same fire-and-forget + SSE shape
 * as the pre-pull route: a multi-hundred-MB load can't hold an HTTP response
 * open past the embedded proxy's 15 s header timeout.
 */
async function runBackgroundLoad(name: string, log: MinimalLogger): Promise<void> {
  // Start the throttle clock now so the first tick is a real percentage,
  // not an immediate "0%".
  let lastEmit = Date.now();
  try {
    await withMutex('switch', async () => {
      publishSwitchEvent({
        stage: 'loading',
        target: 'signalk-server',
        to: name,
        message: `Loading ${name}…`,
      });
      const r = await loadArchive(name, (p) => {
        const now = Date.now();
        if (now - lastEmit < 1500) return;
        lastEmit = now;
        const pct = p.totalBytes > 0 ? Math.round((p.bytesRead / p.totalBytes) * 100) : 0;
        publishSwitchEvent({
          stage: 'loading',
          target: 'signalk-server',
          to: name,
          message: `Loading ${name}… ${pct}% (${fmtBytes(p.bytesRead)} of ${fmtBytes(p.totalBytes)})`,
        });
      });
      if (!r.ok) {
        publishSwitchEvent({
          stage: 'failed',
          target: 'signalk-server',
          to: name,
          error: `load failed: ${r.error}`,
        });
        log.warn({ name, error: r.error }, 'archive load failed');
        return;
      }
      publishSwitchEvent({
        stage: 'complete',
        target: 'signalk-server',
        to: name,
        message: r.refs.length > 0 ? `Loaded ${r.refs.join(', ')}` : `Loaded ${name}`,
      });
      log.info({ name, refs: r.refs, imageId: r.imageId }, 'archive loaded');
    });
  } catch (err) {
    const busy = err instanceof MutexBusyError;
    publishSwitchEvent({
      stage: 'failed',
      target: 'signalk-server',
      to: name,
      error: busy
        ? 'Another operation is in progress — try again once it finishes.'
        : `load failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    log.warn({ name, err }, 'archive load background task error');
  }
}

async function runBackgroundSwitch(
  input: Parameters<typeof performSwitch>[0],
  log: MinimalLogger,
): Promise<void> {
  try {
    const result = await performSwitch(input);
    log.info(
      { to: input.tag, image: input.image, ok: result.ok, rolledBack: result.rolledBack },
      'archive switch finished',
    );
  } catch (err) {
    publishSwitchEvent({
      stage: 'failed',
      target: 'signalk-server',
      to: input.tag,
      error:
        err instanceof MutexBusyError
          ? 'Another operation is in progress — try again once it finishes.'
          : err instanceof Error
            ? err.message
            : String(err),
    });
    log.warn({ to: input.tag, err }, 'archive switch error');
  }
}

/**
 * Local image files (`~/.signalk-updater/images` on the host). Every route
 * takes a bare file NAME — never a path — validated by `isValidArchiveName`.
 * Reads are token-or-localhost (CC-2) so the embedded proxy works without a
 * token; load / switch / delete are bearer.
 */
export async function registerArchiveRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/versions/archives', async (): Promise<ArchivesResponse> => listArchives());

  app.post<{ Body: { name?: unknown } }>(
    '/api/versions/archives/load',
    { preHandler: requireToken },
    async (req, reply) => {
      const name = req.body?.name;
      if (typeof name !== 'string' || !isValidArchiveName(name)) {
        reply.code(400);
        return { error: 'name must be a file in the image folder (*.tar, *.tar.gz, *.tgz)' };
      }
      const { archives } = await listArchives();
      if (!archives.some((a) => a.name === name)) {
        reply.code(404);
        return { error: 'no such archive' };
      }
      void runBackgroundLoad(name, app.log);
      reply.code(202);
      return { ok: true, accepted: true, name };
    },
  );

  app.post<{ Body: { name?: unknown; skipBackup?: unknown } }>(
    '/api/versions/archives/switch',
    { preHandler: requireToken },
    async (req, reply) => {
      const name = req.body?.name;
      if (typeof name !== 'string' || !isValidArchiveName(name)) {
        reply.code(400);
        return { error: 'name must be a file in the image folder (*.tar, *.tar.gz, *.tgz)' };
      }
      const [{ archives }, { image: preferredRepo }] = await Promise.all([
        listArchives(),
        resolveSignalkImage(),
      ]);
      const archive = archives.find((a) => a.name === name);
      if (!archive) {
        reply.code(404);
        return { error: 'no such archive' };
      }
      const picked = pickArchiveRef(archive, preferredRepo);
      if (!picked) {
        reply.code(409);
        return {
          error:
            'this archive carries no repository:tag — re-create it with ' +
            '`podman save <repo>:<tag> -o file.tar` (or load it first if it is compressed)',
        };
      }
      if (!archive.loaded) {
        reply.code(409);
        return { error: 'load the archive first, then switch' };
      }
      void runBackgroundSwitch(
        {
          tag: picked.tag,
          image: picked.ref,
          skipPull: true,
          source: { kind: 'archive', name, mtimeMs: Date.parse(archive.mtime) },
          ...(typeof req.body?.skipBackup === 'boolean' ? { skipBackup: req.body.skipBackup } : {}),
        },
        app.log,
      );
      reply.code(202);
      return { ok: true, accepted: true, to: picked.tag, image: picked.ref };
    },
  );

  app.delete<{ Params: { name: string } }>(
    '/api/versions/archives/:name',
    { preHandler: requireToken },
    async (req, reply) => {
      const { name } = req.params;
      if (!isValidArchiveName(name)) {
        reply.code(400);
        return { error: 'invalid archive name' };
      }
      const removed = await deleteArchive(name);
      if (!removed) {
        reply.code(404);
        return { error: 'no such archive' };
      }
      reply.code(204);
      return null;
    },
  );
}
