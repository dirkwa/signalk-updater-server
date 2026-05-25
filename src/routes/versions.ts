import type { FastifyInstance } from 'fastify';
import { listTags } from '../ghcr.js';
import type { AnnotatedTag, Channel, VersionSettings } from '../types.js';
import { requireToken } from '../auth.js';
import { listLocalImagesFor } from '../local-images.js';
import { readVersionSettings, writeVersionSettings } from '../version-settings.js';
import { pullImage } from '../container-ops.js';

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
    return { ok: false, status: 502, body: { error: r.error.userMessage, kind: r.error.kind } };
  }
  const local = await listLocalImagesFor([TARGET_IMAGE]);
  const localTags = new Set(local.images.map((i) => i.tag));
  const annotated: AnnotatedTag[] = r.tags.map((t) => ({ ...t, isLocal: localTags.has(t.name) }));
  return { ok: true, cachedAt: r.cachedAt, channels: groupByChannel(annotated) };
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

  // Pre-pull an image without switching to it. Lets an operator
  // stage an upgrade on Wi-Fi and apply it later under cellular.
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
      const r = await pullImage(fullRef);
      if (!r.ok) {
        reply.code(500);
        return { error: r.error ?? 'pull failed' };
      }
      return { ok: true, image: fullRef };
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
