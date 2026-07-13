import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * Minimal JSON GET on node:http/https for probing sibling containers.
 *
 * Exists because global `fetch` cannot do the two things these local
 * liveness/version probes need — the same lesson `probeOnce` in
 * container-ops.ts already learned for the switch health-poll:
 *
 *  - accept a self-signed cert (`rejectUnauthorized: false` has no
 *    per-call fetch knob without shipping undici in the prod image), and
 *  - follow signalk-server's SSL-plugin `:80 → https://…:443` redirect
 *    without the redirect target's unverifiable cert killing the request
 *    (`SELF_SIGNED_CERT_IN_CHAIN`).
 *
 * Distinct from `probeOnce` because that caller only needs liveness
 * (status 2xx, body discarded) while RuntimeIdentity needs the parsed
 * JSON body. Follows at most one redirect, sharing the caller's time
 * budget across both hops. Never throws — every failure resolves to
 * `{ ok: false, error }` where `error` is a short reason code the caller
 * can log ('ECONNREFUSED', 'timeout', 'http-503', 'bad-json', …).
 */

export type JsonProbeResult = { ok: true; body: unknown } | { ok: false; error: string };

export interface JsonProbeOptions {
  /** Accept a self-signed / otherwise-unverifiable TLS chain (https
   *  only; harmless on http). Callers probing signalk-server opt in —
   *  its SSL plugin serves a self-signed cert until the operator
   *  installs a real one. This is a version read on a link-local
   *  sibling, not a security boundary. */
  allowSelfSigned?: boolean;
}

/** Version/health documents are a few hundred bytes; anything past 1 MiB
 *  means we're talking to something that isn't the endpoint we think. */
const MAX_BODY_BYTES = 1024 * 1024;

type OnceResult =
  | { kind: 'redirect'; url: string }
  | { kind: 'body'; body: unknown }
  | { kind: 'error'; error: string };

function getJsonOnce(
  url: string,
  timeoutMs: number,
  allowSelfSigned: boolean,
): Promise<OnceResult> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ kind: 'error', error: 'bad-url' });
      return;
    }
    // node's request() throws ERR_INVALID_PROTOCOL synchronously for
    // anything but http/https (a hostile/broken sibling could redirect
    // to ftp: etc.) — that throw would reject out of probeJson into
    // callers that stopped try/catching. Guard it into a reason code.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      resolve({ kind: 'error', error: 'unsupported-protocol' });
      return;
    }
    const isHttps = parsed.protocol === 'https:';
    const request = isHttps ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method: 'GET',
        timeout: timeoutMs,
        // Only meaningful on https; harmless on http.
        ...(isHttps && allowSelfSigned ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          // Resolve the Location against the request URL; a malformed
          // header must not throw in the response callback (uncaught →
          // process crash), so degrade it to a plain HTTP failure.
          let redirect: string | undefined;
          try {
            redirect = new URL(location, url).toString();
          } catch {
            redirect = undefined;
          }
          resolve(
            redirect !== undefined
              ? { kind: 'redirect', url: redirect }
              : { kind: 'error', error: `http-${status}` },
          );
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          resolve({ kind: 'error', error: `http-${status}` });
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            res.destroy();
            resolve({ kind: 'error', error: 'body-too-large' });
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            resolve({
              kind: 'body',
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
            });
          } catch {
            resolve({ kind: 'error', error: 'bad-json' });
          }
        });
        res.on('error', () => resolve({ kind: 'error', error: 'read-error' }));
      },
    );
    // The 'timeout' event is socket idle time, which covers the classic
    // silent-drop hang (SYN into a blackhole). Destroy with a marker
    // error so the 'error' handler reports 'timeout', not a bare socket
    // teardown.
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => {
      const code = (err as Error & { code?: string }).code;
      resolve({ kind: 'error', error: code ?? err.message ?? 'request-error' });
    });
    req.end();
  });
}

/**
 * GET `url` and parse the response as JSON, following at most one
 * redirect (signalk-server's SSL-plugin `:80 → :443` hop). `timeoutMs`
 * bounds the whole exchange including the redirect hop.
 */
export async function probeJson(
  url: string,
  timeoutMs: number,
  options: JsonProbeOptions = {},
): Promise<JsonProbeResult> {
  const allowSelfSigned = options.allowSelfSigned ?? false;
  const started = Date.now();
  const first = await getJsonOnce(url, timeoutMs, allowSelfSigned);
  if (first.kind === 'redirect') {
    const left = timeoutMs - (Date.now() - started);
    if (left <= 0) return { ok: false, error: 'timeout' };
    const second = await getJsonOnce(first.url, left, allowSelfSigned);
    if (second.kind === 'redirect') return { ok: false, error: 'redirect-loop' };
    if (second.kind === 'error') return { ok: false, error: second.error };
    return { ok: true, body: second.body };
  }
  if (first.kind === 'error') return { ok: false, error: first.error };
  return { ok: true, body: first.body };
}
