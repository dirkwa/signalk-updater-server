import { describe, it, expect, afterEach } from 'vitest';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { pollHealth } from '../src/container-ops.js';

// Throwaway self-signed cert (CN=localhost), generated once for this test.
// Embedded so the suite has no openssl / runtime cert-gen dependency. No
// secret value — it only exists to make a local HTTPS listener present an
// unverifiable chain, exactly like signalk-server's SSL plugin does.
const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUSivkqPN4DGvlPzaRcvAkwG70igAwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDYxNDIyMzA0NVoXDTM2MDYx
MTIyMzA0NVowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAmexvc9UzxIMbRJU/VctwEbkghHliamT7Wt9d16keRBV9
GtzvFYcnOEdDReIV4z4qC0eOBYJYSUHsq5svh30y4+Xwv/ql/RDnYVgFpxvvMLtP
OVDDdqO8R0Xsfu5yDE+uiy+mLuADDx+WaDY/KwuNgFysjwaaDbSj7K+KFUqMwNFT
LDDiCoxLjKQ5qNJ2YW5FGiJMnaHHFjWfc+LQLXfSd2rkDy78leKRAb342ox/8vpS
qrSthm3b73ysG8xCPVbg+mqONpBw9VyECD+HJz5OYYzULpIzZF2vE52+g/kQ6fzM
Za/OZNdS+uuLeHbH04CFrGs2pBe4YjHmKNhInrnvtQIDAQABo1MwUTAdBgNVHQ4E
FgQUh/ATsqyie8b2XDR2tqiSJtmA/8swHwYDVR0jBBgwFoAUh/ATsqyie8b2XDR2
tqiSJtmA/8swDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAClLv
iqE7sXl0QhgFMUsxAFVmiM0GlIKObvgdCR4sdaghAy2ty1FWWoru9zROFfDaSjR8
oZ4E2mzGhTRp4sMsM+2SqC/UnWzZHSioy11exjcTYqUaPx4K9mRtQ07ET24aZqYq
iIaIgtQ5DA14Ne1VLWkFbeCHO+Dj7DY8JnaIeh/uMx1h3DuOSKRLqmldy76oiCTw
b4T7ZMfBSeL8InlMD/5MaRhETD6DwdfuYq5uhybJHUGQD0gU1xQQvI09dNVg9dyY
UglkP995FY4g+4X/29g3prCYoym2t9WU0CWipfTeCNt6dhR2uYWUBTZXN3CRfu88
h6tDNA/mFuD/w/ItiA==
-----END CERTIFICATE-----`;

const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCZ7G9z1TPEgxtE
lT9Vy3ARuSCEeWJqZPta313XqR5EFX0a3O8Vhyc4R0NF4hXjPioLR44FglhJQeyr
my+HfTLj5fC/+qX9EOdhWAWnG+8wu085UMN2o7xHRex+7nIMT66LL6Yu4AMPH5Zo
Nj8rC42AXKyPBpoNtKPsr4oVSozA0VMsMOIKjEuMpDmo0nZhbkUaIkydoccWNZ9z
4tAtd9J3auQPLvyV4pEBvfjajH/y+lKqtK2GbdvvfKwbzEI9VuD6ao42kHD1XIQI
P4cnPk5hjNQukjNkXa8Tnb6D+RDp/Mxlr85k11L664t4dsfTgIWsazakF7hiMeYo
2Eieue+1AgMBAAECggEABvqg7QwYLktRg7EOr5mrSapuroMActmEShEBpMMew7CD
vSGSV5QKs7MLelIvct/BMUS7zEUmMqAiFn/RTl/fXFTzLwky2IAZNaEzlGmgVUHQ
7ETcr/bplQO3HuQ52JQOUnJFIy/2A4wHmk8HWzDJaC4LhuqiNoffvN4SsTdxnVZu
Xg/AQkuXm57uZblci3yZU+P8PL2WZAL2DG1t5nTmtWn8y99in9UR/bX9t6uBPuvR
eMA4EFUK3Tr3UhOX+KZkJF93u4Jrp30+oOk1I4PeYuQIycaS9/2S97yR6x2jDMDl
3G0DOMZSkBFQTqjlqygC+k1Q4xPgA+feo7DCqIC4ywKBgQDPHRMJba6LLOF51y7i
KXxFKr4fGjTlFSXHsbbU6X66jZGI5C3JpCDKTPdIJpmoJ6QzeQFwZD3z1GxpupMY
95rCbhkzmP/l8QlznfTExxBZa0w1NV6/HO8d8zMB2RmKG0G+R6q7o2XlK41Nq1QD
jqtEt1z1kTdck9LvpQoA9K1wswKBgQC+QVU20NQcXaWK0nprGBmPNNiDxmFeyVWe
3WXN35SKQLdZ40SG4WoWwo/cXjVcACRV2fsxBlnYfR5tR5m7tZ1hjSt7Ls2nU1WY
b3mqJdqoF5mZsQSGBU6FpETcI9NSZMS8wxj2K+xAlv4QUMITexfWZ0+Ke/WAOWGh
OCxT4AiB9wKBgEdiQflx8ELPyTbxT5trqQU94iFeKvT6APd+7QEdKSyrNonz+0QQ
aazQMjqP803du95xymkuY5vyjxsxzxk/3fs9bzo1dZ2PIi7TNlXMNnpbXPzJ1EoS
cufjtqTgaskK8/HdSZ86hhgilqU6c852EdmxSTzqPCaQXJd0Tqpdqpm5AoGAfYeL
2vwUR5b+R8cyIIEpNBTRGrkEu86poIVBy4FOd53VnAhYyYnnPpcm5mZ+XHJ3hvGp
TCJ9m1qKfd31MCXXbmr/mmo6JMHWQxqiMsKBL9FKdl6Wtnq/4WuOR5WXs9BrAoTT
bnFykvdNMKSoOMRJ6RwHHj9Fr1Gs+fufO8QguOcCgYB/lALxM5pqj2XUGY0JoFtV
XuzgPEtwzGRr+hxT2EgmhrR6JTLQ6r+WTdVy636lIPGC0Igoj+VfSjiCFlUFxEys
FI39l0/phHdRSIxhfYLV1EprWOsbAWeUG1h9pUDQQO1h9opMAs9M6M8OPhdPBiSr
7U+90UT5odeUIe+DQngSog==
-----END PRIVATE KEY-----`;

const servers: Array<HttpServer | HttpsServer> = [];

function port(s: HttpServer | HttpsServer): number {
  const addr = s.address();
  if (!addr || typeof addr === 'string') throw new Error('server not listening on a TCP port');
  return addr.port;
}

function listen(s: HttpServer | HttpsServer): Promise<void> {
  servers.push(s);
  return new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

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
