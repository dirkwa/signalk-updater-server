import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { resolveRuntime, safe } from './podman/client.js';

/** A single coarse pull-progress tick. Derived from dockerode's
 *  followProgress event stream — `layers` is the count of distinct layer
 *  ids seen, `current` the status line of the most recent event. Enough to
 *  show "pull is alive and advancing" without parsing per-layer byte
 *  counts. */
export interface PullProgress {
  layers: number;
  current: string;
}

interface DockerProgressEvent {
  id?: string;
  status?: string;
}

/**
 * Pull an image via dockerode and wait for the streamed progress to finish.
 * Used by the signalk-server switch flow, the doctor self-update, and the
 * standalone pre-pull route — the same registry / network / disk concerns
 * apply to all.
 *
 * `onProgress` (optional) is invoked on followProgress events with a coarse
 * tick. The pre-pull route uses it to publish SSE progress so the UI shows
 * the (multi-minute) pull advancing; the switch/doctor flows omit it (their
 * own stage events already cover the pull). Throwing inside onProgress is
 * swallowed so a UI hiccup can't fail the pull.
 */
export async function pullImage(
  image: string,
  onProgress?: (p: PullProgress) => void,
): Promise<{ ok: boolean; error?: string }> {
  const rt = await resolveRuntime();
  if (!rt) return { ok: false, error: 'runtime unreachable' };
  const seenLayers = new Set<string>();
  const r = await safe(
    () =>
      new Promise<void>((resolve, reject) => {
        rt.client.pull(image, {}, (err, stream) => {
          if (err) return reject(err);
          if (!stream) return resolve();
          rt.client.modem.followProgress(
            stream,
            (e) => (e ? reject(e) : resolve()),
            (event: DockerProgressEvent) => {
              if (!onProgress) return;
              if (event.id) seenLayers.add(event.id);
              try {
                onProgress({ layers: seenLayers.size, current: event.status ?? '' });
              } catch {
                // never let a progress-listener error abort the pull
              }
            },
          );
        });
      }),
  );
  return r.ok ? { ok: true } : { ok: false, error: r.error.userMessage };
}

/**
 * Start a throwaway container from the given image with `node --version`
 * as the entrypoint override. Returns ok when the image starts (Running)
 * or exits cleanly (ExitCode 0). The point is "does this image even
 * start" — not a deep health check, that's pollHealth's job.
 *
 * The temp container is force-removed in the `finally` block.
 */
export async function trialRun(
  image: string,
  namePrefix: string,
): Promise<{ ok: boolean; error?: string }> {
  const rt = await resolveRuntime();
  if (!rt) return { ok: false, error: 'runtime unreachable' };

  const createResult = await safe(() =>
    rt.client.createContainer({
      Image: image,
      name: `${namePrefix}-${Date.now()}`,
      Cmd: ['node', '--version'],
      HostConfig: { AutoRemove: false },
    }),
  );
  if (!createResult.ok) return { ok: false, error: createResult.error.userMessage };
  const created = createResult.value;

  const startResult = await safe(() => created.start());
  if (!startResult.ok) {
    await safe(() => created.remove({ force: true }));
    return { ok: false, error: startResult.error.userMessage };
  }

  try {
    await delay(3000);
    const inspectResult = await safe(() => created.inspect());
    if (!inspectResult.ok) {
      return { ok: false, error: inspectResult.error.userMessage };
    }
    const info = inspectResult.value as unknown as {
      State?: { Running?: boolean; ExitCode?: number };
    };
    if (info.State?.Running) return { ok: true };
    if (info.State?.ExitCode === 0) return { ok: true };
    return { ok: false, error: `trial exited with code ${info.State?.ExitCode}` };
  } finally {
    await safe(() => created.remove({ force: true }));
  }
}

/**
 * Default health-poll timeout for switch flows. This bounds how long we
 * wait for the new container's HTTP health endpoint to answer 2xx —
 * i.e. the *application* to be serving, which for signalk-server is well
 * after the container process has started (30+ plugins to load on a cold
 * boat install). It is deliberately generous and is NOT the same thing as
 * the Quadlet's `TimeoutStartSec` (that bounds container *start*, a much
 * earlier event). 180s comfortably covers a healthy cold start; a probe
 * that's still failing at the deadline means the image is genuinely
 * unhealthy, not slow.
 */
export const DEFAULT_HEALTH_TIMEOUT_MS = 180_000;

export interface PollHealthProgress {
  elapsedMs: number;
  timeoutMs: number;
  attempt: number;
}

export interface PollHealthOptions {
  onProgress?: (p: PollHealthProgress) => void;
  /**
   * Accept a self-signed / otherwise-unverifiable TLS cert on the health
   * probe. signalk-server's SSL plugin makes `:80/signalk` redirect to a
   * self-signed `https://…:443/signalk`; a verifying client throws
   * `SELF_SIGNED_CERT_IN_CHAIN` on every attempt and the poll times out
   * even though the server is perfectly healthy (reproduced 2026-06-15).
   * This is a liveness probe to a known-local sibling container over a
   * link-local address, not a security boundary — cert verification adds
   * nothing here, so signalk-server callers opt in. The doctor's probe is
   * plain http and leaves this off.
   */
  allowSelfSigned?: boolean;
}

interface ProbeResult {
  ok: boolean;
  /** Location header on a 3xx, so the caller can follow one redirect
   *  (the SSL plugin's :80 → :443 hop) without a redirect-following
   *  fetch that would re-verify the cert. */
  redirect?: string;
}

/**
 * Single HTTP(S) GET that resolves to whether the response was 2xx, using
 * `node:http` / `node:https` directly rather than `fetch`. The raw client
 * is what lets us set `rejectUnauthorized: false` for the self-signed
 * case (the global `fetch` has no per-call TLS knob without pulling in
 * undici, which isn't in the production `--omit=dev` image). Bounded by
 * `timeoutMs`; any error (connect refused, TLS, timeout) resolves to
 * `{ ok: false }` so the caller just retries.
 */
function probeOnce(url: string, timeoutMs: number, allowSelfSigned: boolean): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ ok: false });
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
        // Drain so the socket frees promptly; we don't need the body.
        res.resume();
        if (status >= 300 && status < 400 && location) {
          // Resolve the Location against the request URL. This runs in the
          // response callback, not the Promise executor, so a malformed
          // header here would throw as an uncaught exception and crash the
          // process — guard it and treat a bad redirect as a non-redirecting
          // failure (the caller just retries / gives up at the deadline).
          let redirect: string | undefined;
          try {
            redirect = new URL(location, url).toString();
          } catch {
            redirect = undefined;
          }
          resolve({ ok: false, redirect });
          return;
        }
        resolve({ ok: status >= 200 && status < 300 });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false }));
    req.end();
  });
}

/**
 * Poll a health endpoint until it returns 2xx or the deadline expires.
 * Used by switch flows to confirm the new image actually came up healthy
 * before declaring success.
 *
 * Follows a single redirect per attempt so signalk-server's SSL-plugin
 * `:80 → :443` hop is transparent. `onProgress` (optional) is called once
 * before each attempt with the elapsed time, configured timeout, and
 * attempt number — switch flows use this to publish stage events to the
 * UI so the user sees the poll is alive instead of a silent stretch that
 * looks hung.
 */
export async function pollHealth(
  url: string,
  timeoutMs: number,
  options: PollHealthOptions = {},
): Promise<boolean> {
  const { onProgress, allowSelfSigned = false } = options;
  const start = Date.now();
  const deadline = start + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    onProgress?.({ elapsedMs: Date.now() - start, timeoutMs, attempt });
    // Bound each probe by the time remaining on the global deadline so one
    // stalled request can't blow past timeoutMs. Minimum 50ms guards the
    // deadline edge.
    const perAttempt = Math.max(50, deadline - Date.now());
    let r = await probeOnce(url, perAttempt, allowSelfSigned);
    // Follow exactly one redirect (the SSL plugin's :80 → :443). Bound the
    // second leg by whatever time is left, never below the 50ms floor.
    if (!r.ok && r.redirect) {
      const left = Math.max(50, deadline - Date.now());
      r = await probeOnce(r.redirect, left, allowSelfSigned);
    }
    if (r.ok) return true;
    // Deadline-respecting clamp on the inter-attempt sleep.
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(2000, remaining));
  }
  return false;
}
