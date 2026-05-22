import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import { resolveRuntime } from '../podman/client.js';

const HEARTBEAT_MS = 15000;

export async function registerLogStreamRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { name: string }; Querystring: { tail?: string } }>(
    '/api/containers/:name/logs/stream',
    async (req, reply: FastifyReply) => {
      const name = req.params.name;
      if (!/^[a-z0-9][-_a-z0-9]*$/i.test(name)) {
        reply.code(400);
        return { error: 'invalid container name' };
      }
      const tail = Math.max(1, Math.min(5000, Number.parseInt(req.query.tail ?? '200', 10) || 200));

      const rt = await resolveRuntime();
      if (!rt) {
        reply.code(503);
        return { error: 'container runtime not reachable' };
      }

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      const c = rt.client.getContainer(name);
      let stopped = false;
      let stream: Readable | null = null;

      const send = (data: string): void => {
        if (stopped) return;
        for (const line of data.split('\n')) {
          if (!line) continue;
          reply.raw.write(`data: ${line}\n\n`);
        }
      };

      try {
        const s = (await c.logs({
          stdout: true,
          stderr: true,
          follow: true,
          tail: String(tail) as unknown as number,
          timestamps: false,
        })) as Readable;
        stream = s;
      } catch (err) {
        reply.raw.write(
          `event: error\ndata: ${err instanceof Error ? err.message : 'unknown'}\n\n`,
        );
        reply.raw.end();
        return reply;
      }

      const heartbeat = setInterval(() => {
        if (!stopped) reply.raw.write(`: heartbeat\n\n`);
      }, HEARTBEAT_MS);

      stream.on('data', (chunk: Buffer) => send(chunk.toString('utf8')));
      stream.on('end', () => {
        if (!stopped) {
          reply.raw.write('event: end\ndata: stream ended\n\n');
          reply.raw.end();
        }
        clearInterval(heartbeat);
      });
      stream.on('error', (err) => {
        if (!stopped) {
          reply.raw.write(`event: error\ndata: ${err.message}\n\n`);
          reply.raw.end();
        }
        clearInterval(heartbeat);
      });

      req.raw.on('close', () => {
        stopped = true;
        clearInterval(heartbeat);
        const destroyable = stream as { destroy?: () => void } | null;
        destroyable?.destroy?.();
      });
      return reply;
    },
  );
}
