// Shared throwaway-server scaffolding for the probe/poll test suites
// (http-probe, poll-health, runtime-version). Every server registered
// through listen() is torn down by closeAllServers(), which each suite
// calls from its own afterEach.
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { Server as HttpsServer } from 'node:https';

const servers: Array<HttpServer | HttpsServer> = [];

export function port(s: HttpServer | HttpsServer): number {
  const addr = s.address();
  if (!addr || typeof addr === 'string') throw new Error('server not listening on a TCP port');
  return addr.port;
}

export function listen(s: HttpServer | HttpsServer): Promise<void> {
  servers.push(s);
  return new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
}

export async function closeAllServers(): Promise<void> {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
}

/** Local server answering every request with the given status + JSON body.
 *  Returns the base URL. */
export async function jsonServer(status: number, body: unknown): Promise<string> {
  const srv = createHttpServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await listen(srv);
  return `http://127.0.0.1:${port(srv)}`;
}
