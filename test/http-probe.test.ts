import { describe, it, expect, afterEach } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { probeJson } from '../src/http-probe.js';
import { SELF_SIGNED_CERT, SELF_SIGNED_KEY } from './fixtures/self-signed-cert.js';
import { port, listen, closeAllServers } from './fixtures/local-server.js';

afterEach(closeAllServers);

describe('probeJson', () => {
  it('returns the parsed body of a plain-http 200', async () => {
    const srv = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '0.7.0' }));
    });
    await listen(srv);
    const r = await probeJson(`http://127.0.0.1:${port(srv)}/api/health`, 2000);
    expect(r).toEqual({ ok: true, body: { version: '0.7.0' } });
  });

  it('follows the :80 → self-signed :443 redirect with allowSelfSigned (the SSL-plugin hop)', async () => {
    // The exact field failure behind the dashboard's "—" version cell:
    // /signalk on the http port 302s to a self-signed https endpoint.
    const https = createHttpsServer(
      { cert: SELF_SIGNED_CERT, key: SELF_SIGNED_KEY },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ endpoints: { v1: { version: '2.30.0' } } }));
      },
    );
    await listen(https);
    const httpsPort = port(https);
    const http = createHttpServer((_req, res) => {
      res.writeHead(302, { location: `https://127.0.0.1:${httpsPort}/signalk` });
      res.end();
    });
    await listen(http);

    const lax = await probeJson(`http://127.0.0.1:${port(http)}/signalk`, 2000, {
      allowSelfSigned: true,
    });
    expect(lax).toEqual({ ok: true, body: { endpoints: { v1: { version: '2.30.0' } } } });

    // Without allowSelfSigned the redirect target's cert is rejected.
    const strict = await probeJson(`http://127.0.0.1:${port(http)}/signalk`, 2000);
    expect(strict.ok).toBe(false);
  });

  it('reports a second redirect as redirect-loop instead of following it', async () => {
    const srv = createHttpServer((req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${port(srv)}${req.url}` });
      res.end();
    });
    await listen(srv);
    const r = await probeJson(`http://127.0.0.1:${port(srv)}/loop`, 2000);
    expect(r).toEqual({ ok: false, error: 'redirect-loop' });
  });

  it('reports non-2xx as http-<status>', async () => {
    const srv = createHttpServer((_req, res) => {
      res.writeHead(503);
      res.end('nope');
    });
    await listen(srv);
    const r = await probeJson(`http://127.0.0.1:${port(srv)}/api/health`, 2000);
    expect(r).toEqual({ ok: false, error: 'http-503' });
  });

  it('reports an unparseable body as bad-json', async () => {
    const srv = createHttpServer((_req, res) => {
      res.writeHead(200);
      res.end('<html>not json</html>');
    });
    await listen(srv);
    const r = await probeJson(`http://127.0.0.1:${port(srv)}/signalk`, 2000);
    expect(r).toEqual({ ok: false, error: 'bad-json' });
  });

  it('reports connect-refused with the errno code', async () => {
    // Port 1 is privileged + unused — connect refused.
    const r = await probeJson('http://127.0.0.1:1/signalk', 2000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('ECONNREFUSED');
  });

  it('reports a server that accepts but never answers as timeout', async () => {
    // The pasta map-guest-addr blackhole from the 2026-07-12 field report
    // hangs at connect; an accept-then-silence server exercises the same
    // idle-timeout path without needing an unroutable address.
    const srv = createHttpServer(() => {
      /* never respond */
    });
    await listen(srv);
    const started = Date.now();
    const r = await probeJson(`http://127.0.0.1:${port(srv)}/signalk`, 500);
    expect(r).toEqual({ ok: false, error: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('does not crash on a malformed Location header', async () => {
    // `http://` has no host and fails URL parsing even against a base —
    // the redirect degrades to a plain http-302 failure instead of
    // throwing out of the response callback.
    const srv = createHttpServer((_req, res) => {
      res.writeHead(302, { location: 'http://' });
      res.end();
    });
    await listen(srv);
    const r = await probeJson(`http://127.0.0.1:${port(srv)}/signalk`, 1000);
    expect(r).toEqual({ ok: false, error: 'http-302' });
  });

  it('reports an invalid URL as bad-url', async () => {
    const r = await probeJson('not a url', 1000);
    expect(r).toEqual({ ok: false, error: 'bad-url' });
  });

  it('rejects a non-http(s) redirect target without throwing', async () => {
    // node's request() throws ERR_INVALID_PROTOCOL synchronously for
    // ftp:/file:/etc. — the guard must turn that into a reason code, not
    // a rejection escaping into /api/state.
    const srv = createHttpServer((_req, res) => {
      res.writeHead(302, { location: 'ftp://127.0.0.1/pub/version.json' });
      res.end();
    });
    await listen(srv);
    const r = await probeJson(`http://127.0.0.1:${port(srv)}/signalk`, 1000);
    expect(r).toEqual({ ok: false, error: 'unsupported-protocol' });
  });
});
