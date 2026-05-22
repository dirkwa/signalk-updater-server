# signalk-updater-server

Peer engine container for the SignalK container stack. Owns the lifecycle of `signalk-server`: image listing, version switching, self-update, hardware passthrough, and crash-recovery on the mutating side.

This is **not a SignalK plugin** — it runs in its own container alongside `signalk-server`, not inside it. It survives signalk-server being down for any reason, because it is what brings signalk-server back up.

> Status: **skeleton**. Only `GET /api/health` is implemented. The real feature set lands in Phase 4.

## Companion repos

| Repo                                                                                 | Role                                                                               |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [signalk-universal-installer](https://github.com/dirkwa/signalk-universal-installer) | Bash bootstrap that drops both this and signalk-doctor-server as systemd Quadlets. |
| [signalk-doctor-server](https://github.com/dirkwa/signalk-doctor-server)             | Sister engine container — read-only diagnostics + last-known-good recovery.        |
| [signalk-updater](https://github.com/dirkwa/signalk-updater)                         | Thin-shell plugin inside signalk-server that deep-links to this container's UI.    |

## Trust boundary

This container holds the Podman socket, the user-instance DBus socket, and write access to `~/.config/containers/systemd/`. Compromise = host takeover at user-account level. Defensive posture:

- Bound to `127.0.0.1:3003` only.
- Bearer-token auth on every mutating endpoint (token at `~/.signalk-updater/token`, mode 0600).
- Read-only endpoints (`/api/health`, `/api/state`) require token-or-localhost; the doctor's read-only probes are the recovery surface and are intentionally unauthenticated.

## Local dev

```bash
npm install
npm test
npm run dev   # tsx watch src/index.ts, listens on :3003
curl -s http://127.0.0.1:3003/api/health | jq .
```

To build the production image:

```bash
podman build -t signalk-updater-server:dev .
podman run --rm -p 127.0.0.1:3003:3003 -v /run/user/$UID/podman/podman.sock:/var/run/docker.sock signalk-updater-server:dev
```
