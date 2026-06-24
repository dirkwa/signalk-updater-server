import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { createServer } from './server.js';
import { pruneOldImagesFor } from './image-retention.js';

// Full ghcr ref of our own image — same env-driven default as routes/self.ts.
const SELF_IMAGE = process.env.SELF_IMAGE ?? 'ghcr.io/dirkwa/signalk-updater-server';

// Happy-Eyeballs (RFC 8305) attempt timeout for ALL outbound connections,
// including global fetch() — which is how src/ghcr.ts talks to ghcr.io.
// Node 20+ enables autoSelectFamily by default with a 250ms per-address
// cap. On a dual-stack host (ghcr.io is Cloudflare-fronted and resolves
// A+AAAA) reached over a slow link (boat LTE/satellite), the first
// address family's connect can't complete inside 250ms, so the whole
// request fails fast with an ETIMEDOUT/"fetch failed" that the app can't
// extend with its own timeout — surfacing as the transient "registry
// unavailable" tag-fetch error. Widen the cap to 5s (matching the
// noforeignland/nfl-signalk#47 fix for the same Node bug on boat links).
// Built into node:net — no undici/agent dependency, so it works in the
// production --omit=dev image.
// Guard the env override: a non-numeric or absent value falls back to
// 5000 (|| handles NaN), and the floor of 250 (Node's own default) keeps
// a misconfigured "0"/"50" from re-introducing the very instant-fail this
// widens past. A NaN must never reach the setter.
const AUTOSELECT_FAMILY_ATTEMPT_TIMEOUT_MS = Math.max(
  250,
  Number(process.env.AUTOSELECT_FAMILY_ATTEMPT_TIMEOUT_MS) || 5000,
);
setDefaultAutoSelectFamilyAttemptTimeout(AUTOSELECT_FAMILY_ATTEMPT_TIMEOUT_MS);

const PORT = Number(process.env.PORT ?? 3003);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main(): Promise<void> {
  const app = await createServer();
  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Reap old updater-server images on boot. A self-update can't prune inline
  // (the process is mid-restart, still executing from the OLD image's id); by
  // now the new self is confirmed running, so its id is protected and the
  // superseded version beyond the rollback keep is reclaimed. Fire-and-forget.
  void pruneOldImagesFor(
    SELF_IMAGE,
    'signalk-updater-server',
    { protectTags: ['latest', 'beta'] },
    app.log,
  );
}

void main();
