# signalk-updater-server

Peer engine container for the SignalK container stack. Owns image lifecycle, version switching, self-update, hardware UI. Runs alongside (not inside) `signalk-server`.

## Architecture facts you must keep in mind

- **Not a SignalK plugin.** This is a standalone Node 24 container started by systemd-user via a Quadlet that the bash installer (signalk-universal-installer) drops at `~/.config/containers/systemd/signalk-updater-server.container`.
- **Survives signalk-server outages.** Recovery never depends on signalk-server being healthy.
- **Quadlet rewriter.** Every version switch and hardware change is implemented as: (1) snapshot existing Quadlet to `~/.signalk-doctor/snapshots/`, (2) atomic rewrite (tmp + fsync + rename + dir-fsync), (3) DBus → `systemctl --user daemon-reload + restart`. Never edit Quadlets in place.
- **Single-writer mutex.** A file lock at `~/.signalk-updater/operation.lock` serializes switch / self-update / hardware-apply across this container and `signalk-doctor-server`.
- **Bearer-token auth.** All mutating routes require `Authorization: Bearer <token>` (token at `/data/token` inside the container, `~/.signalk-updater/token` on the host).
- **Categorized errors.** Every dockerode call goes through `src/podman/client.ts` `safe()` wrapper that classifies errors into network / auth / disk / permission / not-found / unknown. UI surfaces `userMessage`, never raw error text.

## Cross-cutting requirements (must hold across every PR)

These are derived from the master plan; do not relax them without updating that plan first.

| ID   | Requirement                                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CC-1 | Every Quadlet write snapshots first. Keep last 10 snapshots per file; never prune `last-good`.                                                           |
| CC-2 | Bearer-token auth on all mutating routes. Token at `/data/token` (host-side `~/.signalk-updater/token`, mode 0600).                                      |
| CC-3 | The host-resident `~/.local/bin/signalk-recovery` script is the SSH-only safety net; this container does not own it but must keep its semantics in sync. |
| CC-4 | Quadlets emit `Restart=on-failure`, `StartLimitIntervalSec=300`, `StartLimitBurst=5`. `Restart=always` is banned.                                        |
| CC-5 | Single-writer mutex via `~/.signalk-updater/operation.lock`.                                                                                             |
| CC-6 | Categorized errors at the dockerode wrapper boundary.                                                                                                    |

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
npm run build:all        # lint + tsc + vitest
npm run ci-lint          # eslint + prettier --check (read-only)
cr review --plain | tee /tmp/cr-review-<branch>.txt
```

Skip `cr review` only for `chore(release): X.Y.Z` PRs.

### Release flow

Tag `vX.Y.Z` triggers `.github/workflows/publish.yml` which builds a multi-arch image and pushes to `ghcr.io/dirkwa/signalk-updater-server:X.Y.Z` plus moving tags (`:X.Y`, `:X`, `:latest` for stable, `:beta` for prereleases). Never publish without explicit approval.

## File layout

| Path                            | Purpose                                                                     |
| ------------------------------- | --------------------------------------------------------------------------- |
| `src/index.ts`                  | Entrypoint. Starts fastify.                                                 |
| `src/server.ts`                 | Fastify factory, used by index.ts and tests.                                |
| `src/auth.ts`                   | Bearer-token middleware (CC-2).                                             |
| `src/errors.ts`                 | Error categorization (CC-6).                                                |
| `src/podman/client.ts`          | dockerode wrapper + runtime detection.                                      |
| `src/routes/health.ts`          | `GET /api/health`.                                                          |
| `src/types.ts`                  | TypeScript contracts: `Tag`, `CurrentState`, `SwitchResult`, `Device`, etc. |
| `webapp/`                       | Browser UI (built in Phase 4).                                              |
| `Dockerfile`                    | Multi-stage Node 24 Alpine.                                                 |
| `.github/workflows/ci.yml`      | PR lint + build + test.                                                     |
| `.github/workflows/publish.yml` | Tag-triggered multi-arch buildx → GHCR.                                     |

## Container mounts (final shape — built up across phases)

| Host path                           | Container path         | Mode | Phase added              |
| ----------------------------------- | ---------------------- | ---- | ------------------------ |
| `/run/user/$UID/podman/podman.sock` | `/var/run/docker.sock` | rw   | 2                        |
| `~/.signalk-updater`                | `/data`                | rw   | 2                        |
| `~/.config/containers/systemd`      | `/quadlets`            | rw   | 4d                       |
| `/run/user/$UID/bus`                | `/host/dbus`           | ro   | 4d                       |
| `~/.signalk-doctor`                 | `/doctor-data`         | rw   | 4d                       |
| `~/.signalk-backup`                 | `/backup`              | ro   | 4d (optional, read-only) |
