# signalk-updater-server

Peer engine container for the SignalK container stack. Owns image lifecycle, version switching, self-update, doctor-update, hardware passthrough, and SSE log streaming. Runs alongside (not inside) `signalk-server`.

## Architecture facts you must keep in mind

- **Not a SignalK plugin.** Standalone Node 24 container started by systemd-user via a Quadlet that the bash installer (signalk-universal-installer) drops at `~/.config/containers/systemd/signalk-updater-server.container`.
- **Survives signalk-server outages.** Recovery never depends on signalk-server being healthy. The companion signalk-doctor-server is the further-back safety net for when this container itself is broken (bad self-update, crashloop, DBus dead).
- **Quadlet rewriter.** Every version switch and hardware change is implemented as: (1) snapshot existing Quadlet to `~/.signalk-doctor/snapshots/<timestamp>-<filename>`, (2) atomic rewrite (tmp + fsync + rename + dir-fsync), (3) DBus → `systemctl --user daemon-reload + restart`. Never edit Quadlets in place.
- **Self-update is a DBus self-restart.** `POST /api/self/update` pulls the new image, rewrites its own Quadlet, `daemon-reload`s, flushes the HTTP response, then 500ms later calls `restartUnit('signalk-updater-server.service')` via DBus. systemd then `SIGTERM`s our process and brings it back on the new tag. The response order matters — the client must see `{ ok: true, exiting: true }` before the connection dies. The previous design used `process.exit(0)` and relied on `Restart=on-failure` to bring us back, but `Restart=on-failure` ignores zero exit codes and the unit just went `inactive (dead)` (incident 2026-05-24 17:19 CEST). `restartUnit` works regardless of the `Restart=` policy and is consistent with how every other restart in this codebase is done.
- **Doctor-update is a normal switch.** `POST /api/doctor/update` runs the same pull → trial → rewrite → daemon-reload → restart → health-poll → rollback flow as `signalk-server` switches, but pointed at the doctor's image, Quadlet, and `/api/health` endpoint. The updater stays alive across this flow (no `process.exit`) because it's just rewriting somebody else's Quadlet. The doctor itself never offers a self-update UI by design — the Doctor Console is the read-mostly recovery surface and points users back here for the actual mutation.
- **Daily update check.** `src/update-checker.ts` runs a `setInterval` every 24h (boot-time check is best-effort) that re-queries GHCR for both peer engines' latest stable tags and stores the result in a module-level cache. `GET /api/updates/available` exposes the cache (no auth — read-only view over an already-cached GHCR result), and the App-level webapp badge polls it every 5 min so a user not on the Dashboard tab still sees the notification. **No auto-apply** — boats have unreliable connectivity and surprising restarts during a voyage are dangerous.
- **Switch progress is a broker, not a route return value.** `src/switch-service.ts` and `src/doctor-switch-service.ts` publish coarse stage transitions (`pulling` → `trial` → `rewriting-quadlet` → `daemon-reload` → `restarting` → `health-poll` → `complete` / `failed`) to `src/switch-progress-broker.ts`. The `POST /api/versions/switch` route still returns the final `SwitchResult` for callers that just want the answer; the `GET /api/versions/switch/stream` SSE channel lets the UI render a live progress card. The broker sends its last event on connect so a tab reopened mid-switch picks up the in-flight state.
- **Single-writer mutex.** A file lock at `~/.signalk-updater/operation.lock` serializes switch / self-update / doctor-switch / hardware-apply across this container and `signalk-doctor-server`.
- **Categorized errors.** Every dockerode call goes through `src/podman/client.ts` `safe()` wrapper that classifies errors into network / auth / disk / permission / not-found / unknown. UI surfaces `userMessage`, never raw error text.
- **DBus via shelled-out `busctl`.** Inside the container we call `busctl` (from the `systemd` apt package) against `/host/dbus` instead of a JS DBus library. The host bus enforces EXTERNAL UID handshake, and a JS lib running inside a userns'd container can't satisfy that without invasive plumbing; `busctl` already does the right thing.

## Cross-cutting requirements (must hold across every PR)

These are derived from the master plan; do not relax them without updating that plan first.

| ID   | Requirement                                                                                                                                                                                                                                               |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CC-1 | Every Quadlet write snapshots first via `src/quadlet/rewriter.ts`. Keep last 10 snapshots per file; never prune `last-good`.                                                                                                                              |
| CC-2 | Bearer-token auth on mutating routes (`requireToken` preHandler). Read-only routes allow token-or-localhost so the local plugin proxy works without a token. This DIFFERS from the doctor's policy (doctor's read-only routes are fully unauthenticated). |
| CC-3 | The host-resident `~/.local/bin/signalk-recovery` script is the SSH-only safety net; this container does not own it but must keep its semantics in sync for the updater units it touches.                                                                 |
| CC-4 | Quadlets emit `Restart=on-failure`, `StartLimitIntervalSec=300`, `StartLimitBurst=5`. `Restart=always` is banned.                                                                                                                                         |
| CC-5 | Single-writer mutex via `~/.signalk-updater/operation.lock`. Shared with signalk-doctor-server.                                                                                                                                                           |
| CC-6 | Categorized errors at the dockerode wrapper boundary (`src/podman/client.ts` `safe()`).                                                                                                                                                                   |

## Workflow Conventions

This repo is maintained by Dirk Wahrheit. Workflow is deliberate; AI tools should follow it strictly.

### Branch and commit rules

- Branch names use **hyphens**, never slashes: `fix-something`, `feat-something`, `chore-release-1-6-0`.
- Angular conventional commits: `<type>(<scope>): <subject>`. Types: `feat|fix|docs|style|refactor|test|chore|perf`. Subject ≤ 50 chars, imperative mood, no period.
- One logical change per commit.
- No `Co-Authored-By` lines. No "Generated with Claude Code" attribution.

### PR rules

- Never commit directly to `master`. Every change goes through a PR.
- One logical change per PR.
- PR titles describe what changes; PR bodies explain _why_.
- No checkboxes in PR descriptions. If you need a "Tested" section, list what was actually verified.
- Version bumps live in their own `chore(release): X.Y.Z` PR.

### Pre-PR checklist

```bash
npm run format           # prettier --write . + eslint --fix
npm run build:all        # lint + tsc + vite build + vitest (server + webapp)
npm run ci-lint          # eslint + prettier --check (read-only)
cr review --plain | tee cr-review-<branch>.txt
```

Save the cr output to a repo-local file (the repo `.gitignore`s `cr-review*.txt`); `cr` is rate-limited so reruns are expensive. Skip `cr review` only for `chore(release): X.Y.Z` PRs.

### Release flow

Tag `vX.Y.Z` triggers `.github/workflows/publish-image.yml` which builds a multi-arch image on native runners (`ubuntu-24.04` for amd64, `ubuntu-24.04-arm` for arm64 — no QEMU) and pushes to `ghcr.io/dirkwa/signalk-updater-server:X.Y.Z` plus moving tags (`:X.Y`, `:X`, `:latest` for stable, `:beta` for prereleases). Never publish without explicit approval.

## TypeScript

- `"type": "module"`, ESM throughout. Relative imports use `.js` suffix (NodeNext resolution).
- `tsconfig.json` runs with the full strict-TS set: `strict`, `noImplicitAny`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noImplicitOverride`. Code must narrow against `undefined` when reading array slots or record entries.
- `tsconfig.webapp.json` mirrors the same flag set for the React webapp, plus `jsx: react-jsx` and DOM libs.
- `@typescript-eslint/no-explicit-any` is `error` (not `warn`) — `any` fails CI, not just lint output. Don't replace the guard patterns from #54 with non-null assertions.

## File layout

| Path                                  | Purpose                                                                                                                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                        | Entrypoint. Starts Fastify on `PORT` / `HOST`.                                                                                                                                                                             |
| `src/server.ts`                       | Fastify factory. Registers all routes and serves the built webapp from `WEBAPP_ROOT` (default `/app/public`).                                                                                                              |
| `src/auth.ts`                         | Bearer-token middleware (CC-2). `requireToken` preHandler.                                                                                                                                                                 |
| `src/errors.ts`                       | Error categorization (CC-6).                                                                                                                                                                                               |
| `src/types.ts`                        | TypeScript contracts: `Channel`, `Tag`, `ContainerSnapshot`, `CurrentState`, `SwitchRequest/Result`, `Device`, `HealthResponse`, etc.                                                                                      |
| `src/state.ts`                        | Container inspection + `CurrentState` builder. `tailContainerLogs(name, lines)` for non-streaming tails.                                                                                                                   |
| `src/podman/client.ts`                | dockerode wrapper + runtime (podman/docker) detection. All container calls go here via `safe()`.                                                                                                                           |
| `src/quadlet/rewriter.ts`             | Atomic Quadlet writes + snapshot bookkeeping (CC-1). Owns `last-good.json`.                                                                                                                                                |
| `src/dbus/systemd-user.ts`            | `busctl` shell-out for `systemctl --user daemon-reload` / `restart`.                                                                                                                                                       |
| `src/mutex.ts`                        | File-lock wrapper around `~/.signalk-updater/operation.lock` (CC-5).                                                                                                                                                       |
| `src/container-ops.ts`                | Shared `pullImage`, `trialRun`, `pollHealth` helpers used by every switch flow.                                                                                                                                            |
| `src/switch-service.ts`               | signalk-server version-switch orchestration: pull, trial-run, rewrite Quadlet, daemon-reload, wait for health, rollback on failure.                                                                                        |
| `src/doctor-switch-service.ts`        | signalk-doctor-server version-switch orchestration. Same shape as `switch-service.ts` but with no pre-switch backup (the doctor has no DB).                                                                                |
| `src/self.ts`, `src/ghcr.ts`          | Self-update logic + GHCR registry API.                                                                                                                                                                                     |
| `src/update-checker.ts`               | Daily setInterval that re-queries GHCR for both peer engines. Cache feeds `/api/updates/available`.                                                                                                                        |
| `src/switch-progress-broker.ts`       | In-process pub/sub for switch progress events. Single publisher (the in-flight switch) → N SSE subscribers. Sends the last event on connect.                                                                               |
| `src/local-images.ts`                 | dockerode listImages wrapper filtered by repo prefix; powers `GET /api/versions/local` and the `isLocal` annotation on `GET /api/versions`.                                                                                |
| `src/version-settings.ts`             | Reads/writes `{showBeta, showMaster}` to `/data/version-settings.json` (atomic tmp+rename). Per-install Versions-tab filter.                                                                                               |
| `src/tagClassifier.ts`                | Tag → `stable` / `beta` / `master` / `dirkwa` channel classifier + semver comparator.                                                                                                                                      |
| `src/hardware.ts`                     | Hardware Quadlet section parser / rewriter.                                                                                                                                                                                |
| `src/log-stream-broker.ts`            | In-memory ring buffer + fan-out for container log SSE.                                                                                                                                                                     |
| `src/routes/health.ts`                | `GET /api/health`. No auth.                                                                                                                                                                                                |
| `src/routes/session.ts`               | `GET /api/session` (returns the bearer token from `/data/token` with `Cache-Control: no-store`). No auth.                                                                                                                  |
| `src/routes/state.ts`                 | `GET /api/state`, `GET /api/signalk/logs`. Token-or-localhost.                                                                                                                                                             |
| `src/routes/versions.ts`              | `GET /api/versions` (with `isLocal` annotation), `POST /api/versions/check`, `GET /api/versions/local`, `POST /api/versions/pull`, `GET/PUT /api/versions/settings`. Reads = token-or-localhost; mutating routes = bearer. |
| `src/routes/switch.ts`                | `POST /api/versions/switch`, `POST /api/versions/rollback` (bearer). `GET /api/versions/switch/stream` SSE (no auth — browser EventSource can't set headers).                                                              |
| `src/routes/self.ts`                  | `GET /api/self/state`, `POST /api/self/update`. Update = bearer. Update path calls `restartUnit` via DBus AFTER the response flushes (NOT `process.exit`).                                                                 |
| `src/routes/doctor.ts`                | `GET /api/doctor/state`, `POST /api/doctor/update`. Update = bearer. Drives `performDoctorSwitch`; the updater itself stays alive.                                                                                         |
| `src/routes/updates.ts`               | `GET /api/updates/available` (no auth), `POST /api/updates/check` (bearer). Reads/refreshes the daily-check cache.                                                                                                         |
| `src/routes/lifecycle.ts`             | `POST /api/signalk/{start,stop,restart}`. Bearer.                                                                                                                                                                          |
| `src/routes/hardware.ts`              | `GET /api/hardware`, `POST /api/hardware/apply`. Apply = bearer.                                                                                                                                                           |
| `src/routes/logs-stream.ts`           | `GET /api/containers/:name/logs/stream` (SSE) + `/logs` (snapshot tail). Token-or-localhost. SSE drain has documented string-equality dedup.                                                                               |
| `webapp/index.html`                   | React entry. Inline `<script>` sets `<html data-bs-theme>` from `prefers-color-scheme` before React mounts (avoids flash of wrong theme).                                                                                  |
| `webapp/src/main.tsx`                 | React mount + Bootstrap CSS import + `ToastProvider` / `ConfirmProvider` wrap.                                                                                                                                             |
| `webapp/src/App.tsx`                  | Hash-routed tab shell: Dashboard / Versions / Logs. Brand chip, runtime chip, and `/api/updates/available` badge.                                                                                                          |
| `webapp/src/api.ts`                   | Typed API client. Attaches `Authorization: Bearer` and `X-SK-Auth` on every call (X-SK-Auth forces a CORS preflight; redundant for localhost but harmless).                                                                |
| `webapp/src/session.ts`               | Loads the bearer from `/api/session` at boot.                                                                                                                                                                              |
| `webapp/src/types.ts`                 | Hand-rolled webapp mirror of `src/types.ts`. Drift policy at the top of the file; must change in lockstep with the server types.                                                                                           |
| `webapp/src/time.ts`                  | `fmtTime` / `relTime` helpers.                                                                                                                                                                                             |
| `webapp/src/log-parse.ts`             | pino JSON + bare-line log parser. Handles numeric-string AND ISO-string `time` fields (don't fall back to bare-line parsing on ISO time).                                                                                  |
| `webapp/src/toast.tsx`                | Reactstrap toast queue via `ToastProvider` + `useToast()`. ID counter in a `useRef` (HMR-safe).                                                                                                                            |
| `webapp/src/confirm.tsx`              | Reactstrap modal confirm via `ConfirmProvider` + `useConfirm()`. Promise-based; skip-backup checkbox plumbed for switch flows.                                                                                             |
| `webapp/src/hooks/useApi.ts`          | Polling fetch hook with mount-guard, in-flight cancellation, and visibility-aware interval.                                                                                                                                |
| `webapp/src/hooks/useThemeSync.ts`    | Mirrors OS `prefers-color-scheme` changes onto `<html data-bs-theme>` at runtime.                                                                                                                                          |
| `webapp/src/views/Dashboard.tsx`      | Three container cards (server / updater / doctor), lifecycle buttons, self-update, doctor-update, open-doctor link.                                                                                                        |
| `webapp/src/views/Versions.tsx`       | Per-channel cards with current-tag badge, Local/Remote pills, Pull/Switch row actions, persisted Show-beta / Show-master filter checkboxes, and an SSE-driven progress card during a switch.                               |
| `webapp/src/views/Logs.tsx`           | SSE log viewer with pause / clear / auto-scroll-when-at-bottom + visibility-aware teardown/reconnect.                                                                                                                      |
| `webapp/src/views/*.test.tsx`         | Dashboard + Versions smoke tests. `globalThis.fetch` stubs snapshot the original at module load and restore in `afterEach`.                                                                                                |
| `webapp/src/log-parse.test.ts`        | Pure-function tests for the log parser (16 cases).                                                                                                                                                                         |
| `webapp/test-setup.ts`                | Loads `@testing-library/jest-dom/vitest`.                                                                                                                                                                                  |
| `vite.config.ts`                      | Builds `webapp/` → `public/`. Defines `__APP_VERSION__` from `package.json`. Dev proxy `/api` → `VITE_DEV_API` (default `http://127.0.0.1:3003`).                                                                          |
| `vitest.config.ts`                    | Two projects: `server` (node, `test/**/*.test.ts`) and `webapp` (jsdom + RTL, `webapp/**/*.test.{ts,tsx}`).                                                                                                                |
| `tsconfig.json`                       | Server TS → `dist/`.                                                                                                                                                                                                       |
| `tsconfig.webapp.json`                | Webapp TS typecheck only (`noEmit`; Vite handles emit).                                                                                                                                                                    |
| `Dockerfile`                          | Multi-stage Node 24 on Debian 13 (trixie-slim). Build stage runs both `tsc` and `vite build`; runtime copies `dist/` + `public/`.                                                                                          |
| `.coderabbit.yaml`                    | CodeRabbit review config — encodes the invariants above so PR reviews don't re-litigate them.                                                                                                                              |
| `.github/workflows/ci.yml`            | PR lint + build + test.                                                                                                                                                                                                    |
| `.github/workflows/publish-image.yml` | Tag-triggered multi-arch buildx → GHCR (amd64 on x86, arm64 native on `ubuntu-24.04-arm`, no QEMU).                                                                                                                        |

## Container mounts (final shape)

| Host path                           | Container path         | Mode | Purpose                                                         |
| ----------------------------------- | ---------------------- | ---- | --------------------------------------------------------------- |
| `/run/user/$UID/podman/podman.sock` | `/var/run/docker.sock` | rw   | dockerode talks to the rootless podman socket.                  |
| `~/.signalk-updater`                | `/data`                | rw   | Token at `/data/token` (mode 0600), operation lock file.        |
| `~/.config/containers/systemd`      | `/quadlets`            | rw   | Quadlet reads + atomic writes (CC-1 snapshots).                 |
| `/run/user/$UID/bus`                | `/host/dbus`           | ro   | `busctl --user` against the host session bus.                   |
| `~/.signalk-doctor`                 | `/doctor-data`         | rw   | Quadlet snapshot directory (`/doctor-data/snapshots/`).         |
| `~/.signalk-backup`                 | `/backup`              | ro   | Optional — pre-switch backups when signalk-backup is installed. |

## Webapp

- **React 19 + Vite + reactstrap + Bootstrap 5.** Bundled, not injected. This container runs standalone on port 3003 (not embedded inside signalk-server), so the [signalk-backup](https://github.com/dirkwa/signalk-backup) admin-CSS-injection pattern doesn't apply here. The thin-shell plugin in [signalk-updater](https://github.com/dirkwa/signalk-updater) IS embedded and DOES use that pattern — these are deliberately different.
- **OS-driven color modes** via `data-bs-theme` set by the inline boot script in `webapp/index.html` and kept in sync by `useThemeSync` after mount. No in-UI toggle.
- **Same-origin API calls** at `/api/*`. The Fastify host serves both the API and the static bundle from `public/` (built from `webapp/`). Dev mode runs Vite on `:5173` and proxies `/api` to `VITE_DEV_API` (default `http://127.0.0.1:3003`).
- **Bearer attached on every call** in `webapp/src/api.ts`. The bearer on read-only routes is redundant for localhost (those routes accept token-or-localhost per CC-2) but harmless. Don't tighten this to non-GET-only without checking the consumer paths.
- **Reactstrap component conventions.** Use semantic `color="primary|danger|warning"` props, not hex colors (would break dark mode). Prefer Bootstrap utility classes (`d-flex`, `gap-2`, `text-muted`, `mb-3`, `font-monospace`) over inline styles.
- **SSE auth lives in the trust boundary.** Browser `EventSource` can't set headers, so the log-stream endpoint accepts any client that already crossed the engine's PublishPort. Don't suggest adding `Authorization` to `new EventSource(...)` — there's no way.
- **Test pattern for fetch mocks.** Tests that stub `globalThis.fetch` MUST snapshot the original at module load and restore in `afterEach`. `vi.restoreAllMocks()` does NOT undo direct global assignments. See `webapp/src/views/Dashboard.test.tsx`.

## Webapp / engine type drift

`webapp/src/types.ts` mirrors the engine's REST shapes from `src/types.ts`. The two files MUST stay structurally equivalent — field names, optionality, and string-literal unions match exactly. Cosmetic differences (named `ContainerState`, extracted `UpdaterSnapshot` interface) are documented at the top of `webapp/src/types.ts` and are intentional. When a shape changes in `src/types.ts`, the matching change must land in `webapp/src/types.ts` in the same PR.

## Relationship to signalk-doctor-server

This container is a deliberate code-twin of [signalk-doctor-server](https://github.com/dirkwa/signalk-doctor-server) at the skeleton level: same Fastify factory, same `src/podman/client.ts` shape, same `src/errors.ts`, same Dockerfile pattern. They diverge once each has its real feature set:

- **Updater = mutating.** Writes Quadlets, calls `podman pull`, calls `systemctl --user restart`. Many mutating routes; all bearer-gated.
- **Doctor = read-mostly.** Reads Quadlets and journal, runs probes. Mutation is limited to recovery and is gated. Read-only probes are fully unauthenticated.

Lifting code between the two repos is fine and expected. When a helper proves useful in both, copy with attribution rather than introducing a monorepo.
