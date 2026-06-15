import type { FastifyInstance } from 'fastify';
import { listTags } from '../ghcr.js';
import type { AnnotatedTag, Channel, VersionSettings } from '../types.js';
import { requireToken } from '../auth.js';
import { listLocalImagesFor } from '../local-images.js';
import { readVersionSettings, writeVersionSettings } from '../version-settings.js';
import { pullImage } from '../container-ops.js';
import { withMutex, MutexBusyError } from '../mutex.js';
import { publishSwitchEvent } from '../switch-progress-broker.js';

const TARGET_IMAGE = process.env.SIGNALK_IMAGE ?? 'dirkwa/signalk-server';

function groupByChannel(tags: AnnotatedTag[]): Record<Channel, AnnotatedTag[]> {
  const out: Record<Channel, AnnotatedTag[]> = { stable: [], beta: [], master: [], dirkwa: [] };
  for (const t of tags) out[t.channel].push(t);
  for (const c of Object.keys(out) as Channel[]) {
    out[c].sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
  }
  return out;
}

async function buildVersionsResponse(
  force = false,
): Promise<
  | { ok: true; cachedAt: string; channels: Record<Channel, AnnotatedTag[]> }
  | { ok: false; status: number; body: { error: string; kind: string } }
> {
  const r = await listTags(TARGET_IMAGE, { force });
  if (!r.ok) {
    // Map the failure kind to an honest status. Transient
    // connectivity/registry blips (common on boat LTE links) become 503
    // "Service Unavailable" — a retry-and-it'll-work signal — so the UI
    // can show a calm "try again" instead of an alarming hard error. A
    // genuine upstream/unknown error stays 502. The `error` field always
    // carries the human userMessage so the client never has to fall back
    // to rendering the bare status code.
    const status =
      r.error.kind === 'network' || r.error.kind === 'registry-unavailable' ? 503 : 502;
    return { ok: false, status, body: { error: r.error.userMessage, kind: r.error.kind } };
  }
  const local = await listLocalImagesFor([TARGET_IMAGE]);
  const localTags = new Set(local.images.map((i) => i.tag));
  const annotated: AnnotatedTag[] = r.tags.map((t) => ({ ...t, isLocal: localTags.has(t.name) }));
  return { ok: true, cachedAt: r.cachedAt, channels: groupByChannel(annotated) };
}

interface MinimalLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

/**
 * Run a pre-pull in the background, streaming progress + the terminal
 * result over the switch-progress broker. Takes the shared mutex (a pull
 * contends with switch / self-update / doctor-switch) so it can't race a
 * concurrent switch onto the same image store. A mutex-busy or a pull
 * failure is reported as a `failed` event — the webapp listens for it.
 * Never throws (it's invoked fire-and-forget from the 202 route).
 */
async function runBackgroundPull(tag: string, fullRef: string, log: MinimalLogger): Promise<void> {
  // Throttle progress emits: a big image streams hundreds of layer events;
  // one SSE message per ~1.5s is plenty to show liveness without flooding.
  let lastEmit = 0;
  try {
    await withMutex('switch', async () => {
      publishSwitchEvent({
        stage: 'pulling',
        target: 'signalk-server',
        to: tag,
        message: `Pulling ${tag}…`,
      });
      const r = await pullImage(fullRef, (p) => {
        const now = Date.now();
        if (now - lastEmit < 1500) return;
        lastEmit = now;
        publishSwitchEvent({
          stage: 'pulling',
          target: 'signalk-server',
          to: tag,
          message: `Pulling ${tag}… ${p.layers} layer${p.layers === 1 ? '' : 's'} (${p.current})`,
        });
      });
      if (!r.ok) {
        publishSwitchEvent({
          stage: 'failed',
          target: 'signalk-server',
          to: tag,
          error: `pull failed: ${r.error ?? 'unknown error'}`,
        });
        log.warn({ tag, error: r.error }, 'pre-pull failed');
        return;
      }
      publishSwitchEvent({
        stage: 'complete',
        target: 'signalk-server',
        to: tag,
        message: `Pulled ${tag}`,
      });
      log.info({ tag, image: fullRef }, 'pre-pull complete');
    });
  } catch (err) {
    const busy = err instanceof MutexBusyError;
    publishSwitchEvent({
      stage: 'failed',
      target: 'signalk-server',
      to: tag,
      error: busy
        ? 'Another operation is in progress — try again once it finishes.'
        : `pull failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    log.warn({ tag, err }, 'pre-pull background task error');
  }
}

export async function registerVersionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/versions', async (_req, reply) => {
    const r = await buildVersionsResponse(false);
    if (!r.ok) {
      reply.code(r.status);
      return r.body;
    }
    return { cachedAt: r.cachedAt, channels: r.channels };
  });

  app.post('/api/versions/check', { preHandler: requireToken }, async (_req, reply) => {
    const r = await buildVersionsResponse(true);
    if (!r.ok) {
      reply.code(r.status);
      return r.body;
    }
    return { cachedAt: r.cachedAt, channels: r.channels };
  });

  app.get('/api/versions/local', async () => {
    return listLocalImagesFor([TARGET_IMAGE]);
  });

  // Pre-pull an image without switching to it. Lets an operator stage an
  // upgrade on Wi-Fi and apply it later under cellular.
  //
  // A full signalk-server image pull takes minutes. The embedded plugin
  // proxy kills any upstream request that hasn't produced response headers
  // within its header-timeout (15s), so a blocking POST that holds the
  // response until the pull finishes 502s mid-pull even though podman is
  // still working. So this returns 202 IMMEDIATELY (headers land at once,
  // the proxy is satisfied) and runs the pull in the background, streaming
  // progress + the terminal result over the shared switch-progress broker
  // (target: 'signalk-server'). The webapp drives the outcome off that SSE
  // stream, not this response. Same fix shape as the doctor-update flow.
  app.post<{ Body: { tag?: string } }>(
    '/api/versions/pull',
    { preHandler: requireToken },
    async (req, reply) => {
      const tag = req.body?.tag;
      if (!tag || typeof tag !== 'string') {
        reply.code(400);
        return { error: 'tag is required' };
      }
      const repo = TARGET_IMAGE.includes('/') ? TARGET_IMAGE : `dirkwa/${TARGET_IMAGE}`;
      const fullRef = repo.startsWith('ghcr.io/') ? `${repo}:${tag}` : `ghcr.io/${repo}:${tag}`;

      // Fire-and-forget: the background task owns all progress/terminal
      // events. Errors (incl. mutex-busy) are reported via SSE, never as an
      // unhandled rejection.
      void runBackgroundPull(tag, fullRef, app.log);

      reply.code(202);
      return { ok: true, accepted: true, image: fullRef };
    },
  );

  app.get('/api/versions/settings', async (): Promise<VersionSettings> => {
    return readVersionSettings();
  });

  app.put<{ Body: Partial<VersionSettings> }>(
    '/api/versions/settings',
    { preHandler: requireToken },
    async (req): Promise<VersionSettings> => {
      // Whitelist the known keys so a misbehaving client can't pollute
      // the settings file with arbitrary fields.
      const patch: Partial<VersionSettings> = {};
      if (typeof req.body?.showBeta === 'boolean') patch.showBeta = req.body.showBeta;
      if (typeof req.body?.showMaster === 'boolean') patch.showMaster = req.body.showMaster;
      return writeVersionSettings(patch);
    },
  );
}
