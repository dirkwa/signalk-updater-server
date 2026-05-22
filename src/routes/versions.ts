import type { FastifyInstance } from 'fastify';
import { listTags } from '../ghcr.js';
import type { Channel, Tag } from '../types.js';
import { requireToken } from '../auth.js';

const TARGET_IMAGE = process.env.SIGNALK_IMAGE ?? 'dirkwa/signalk-server';

function groupByChannel(tags: Tag[]): Record<Channel, Tag[]> {
  const out: Record<Channel, Tag[]> = { stable: [], beta: [], master: [], dirkwa: [] };
  for (const t of tags) out[t.channel].push(t);
  for (const c of Object.keys(out) as Channel[]) {
    out[c].sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
  }
  return out;
}

export async function registerVersionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/versions', async (_req, reply) => {
    const r = await listTags(TARGET_IMAGE);
    if (!r.ok) {
      reply.code(502);
      return { error: r.error.userMessage, kind: r.error.kind };
    }
    return { cachedAt: r.cachedAt, channels: groupByChannel(r.tags) };
  });

  app.post('/api/versions/check', { preHandler: requireToken }, async (_req, reply) => {
    const r = await listTags(TARGET_IMAGE, { force: true });
    if (!r.ok) {
      reply.code(502);
      return { error: r.error.userMessage, kind: r.error.kind };
    }
    return { cachedAt: r.cachedAt, channels: groupByChannel(r.tags) };
  });
}
