import { setTimeout as delay } from 'node:timers/promises';
import { resolveRuntime, safe } from './podman/client.js';

/**
 * Pull an image via dockerode and wait for the streamed progress to finish.
 * Used by both the signalk-server switch flow and the doctor self-update —
 * the same registry / network / disk concerns apply to both.
 */
export async function pullImage(image: string): Promise<{ ok: boolean; error?: string }> {
  const rt = await resolveRuntime();
  if (!rt) return { ok: false, error: 'runtime unreachable' };
  const r = await safe(
    () =>
      new Promise<void>((resolve, reject) => {
        rt.client.pull(image, {}, (err, stream) => {
          if (err) return reject(err);
          if (!stream) return resolve();
          rt.client.modem.followProgress(
            stream,
            (e) => (e ? reject(e) : resolve()),
            () => {
              /* ignore progress events */
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
  let c: { remove: (o?: { force?: boolean }) => Promise<void> } | null = null;
  try {
    const created = await rt.client.createContainer({
      Image: image,
      name: `${namePrefix}-${Date.now()}`,
      Cmd: ['node', '--version'],
      HostConfig: { AutoRemove: false },
    });
    c = { remove: (o) => created.remove(o ?? { force: true }) };
    await created.start();
    await delay(3000);
    const info = (await created.inspect()) as unknown as {
      State?: { Running?: boolean; ExitCode?: number };
    };
    if (info.State?.Running) return { ok: true };
    if (info.State?.ExitCode === 0) return { ok: true };
    return { ok: false, error: `trial exited with code ${info.State?.ExitCode}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  } finally {
    if (c) {
      try {
        await c.remove({ force: true });
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Poll a health endpoint until it returns 2xx or the deadline expires.
 * Used by switch flows to confirm the new image actually came up healthy
 * before declaring success.
 */
export async function pollHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // ignore; retry
    }
    await delay(2000);
  }
  return false;
}
