import { describe, it, expect, afterEach } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { pollHealth } from '../src/container-ops.js';
import { SELF_SIGNED_CERT, SELF_SIGNED_KEY } from './fixtures/self-signed-cert.js';
import { port, listen, closeAllServers } from './fixtures/local-server.js';

afterEach(closeAllServers);

describe('pollHealth', () => {
  it('succeeds against a plain-http 2xx endpoint without allowSelfSigned', async () => {
    const srv = createHttpServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await listen(srv);
    const ok = await pollHealth(`http://127.0.0.1:${port(srv)}/signalk`, 2000);
    expect(ok).toBe(true);
  });

  it('FAILS against a self-signed https endpoint by default (verifying)', async () => {
    const srv = createHttpsServer({ cert: SELF_SIGNED_CERT, key: SELF_SIGNED_KEY }, (_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await listen(srv);
    // Short timeout: a verifying client throws on every attempt, so this
    // just burns the deadline. Keep it tight so the test stays fast.
    const ok = await pollHealth(`https://127.0.0.1:${port(srv)}/signalk`, 800);
    expect(ok).toBe(false);
  });

  it('succeeds against a self-signed https endpoint with allowSelfSigned', async () => {
    const srv = createHttpsServer({ cert: SELF_SIGNED_CERT, key: SELF_SIGNED_KEY }, (_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await listen(srv);
    const ok = await pollHealth(`https://127.0.0.1:${port(srv)}/signalk`, 2000, {
      allowSelfSigned: true,
    });
    expect(ok).toBe(true);
  });

  it('follows a single :80 → self-signed :443 redirect (the SSL-plugin hop)', async () => {
    // This is the exact reproduced failure: http://…/signalk 302s to a
    // self-signed https endpoint. The poll must follow the redirect AND
    // accept the cert to see the 200.
    const https = createHttpsServer(
      { cert: SELF_SIGNED_CERT, key: SELF_SIGNED_KEY },
      (_req, res) => {
        res.writeHead(200);
        res.end('healthy');
      },
    );
    await listen(https);
    const httpsPort = port(https);
    const http = createHttpServer((_req, res) => {
      res.writeHead(302, { location: `https://127.0.0.1:${httpsPort}/signalk` });
      res.end();
    });
    await listen(http);

    // Without allowSelfSigned the redirect target's cert is rejected.
    const strict = await pollHealth(`http://127.0.0.1:${port(http)}/signalk`, 800);
    expect(strict).toBe(false);

    // With it, the hop completes and the 200 is seen.
    const lax = await pollHealth(`http://127.0.0.1:${port(http)}/signalk`, 2000, {
      allowSelfSigned: true,
    });
    expect(lax).toBe(true);
  });

  it('does not crash on a malformed Location header, returns false', async () => {
    // A buggy/hostile server returning an unparseable redirect must not
    // throw out of the response callback (which would be an uncaught
    // exception); the attempt just fails and the poll gives up at the
    // deadline.
    const srv = createHttpServer((_req, res) => {
      res.writeHead(302, { location: ':::not a url' });
      res.end();
    });
    await listen(srv);
    const ok = await pollHealth(`http://127.0.0.1:${port(srv)}/signalk`, 600);
    expect(ok).toBe(false);
  });

  it('returns false when nothing is listening', async () => {
    // Port 1 is privileged + unused — connect refused on every attempt.
    const ok = await pollHealth('http://127.0.0.1:1/signalk', 600);
    expect(ok).toBe(false);
  });

  it('invokes onProgress before each attempt', async () => {
    const attempts: number[] = [];
    await pollHealth('http://127.0.0.1:1/signalk', 600, {
      onProgress: (p) => attempts.push(p.attempt),
    });
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(attempts[0]).toBe(1);
  });
});
