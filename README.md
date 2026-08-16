# signalk-updater-server

Peer engine container for the SignalK container stack. Owns the lifecycle of `signalk-server`: image listing, version switching, self-update, hardware passthrough, and crash-recovery on the mutating side.

This is **not a SignalK plugin** — it runs in its own container alongside `signalk-server`, not inside it. It survives signalk-server being down for any reason, because it is what brings signalk-server back up.

> Status: **1.x**. Version listing/switching, self-update, doctor-update, hardware passthrough, log streaming and the Updater Console webapp are all in place; see AGENTS.md for the route map.

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

## Advanced tab: custom image repository

By default the Versions tab lists, pulls and switches `signalk-server` from
`ghcr.io/dirkwa/signalk-server` (built by
[signalk-server-images](https://github.com/dirkwa/signalk-server-images)). If you run your own
fork of that repo, open **Advanced** in the Updater Console and enter your repository, e.g.
`ghcr.io/<owner>/signalk-server`. The value is validated (GHCR only, no tag, no digest),
canonicalised, and persisted per install in `~/.signalk-updater/version-settings.json`
(`imageRepo`). It takes effect immediately for listing and pre-pulls; the running container is
untouched until the next Switch, which writes the new repository into the Quadlet. Rollback
always returns to the exact image ref it was recorded from, even after a repository change.

Precedence: the Advanced-tab setting wins; when unset, `SIGNALK_IMAGE` (an env override on the
engine container, meant for dev/CI) is the default; when neither is set, the built-in dirkwa repo.
The Advanced tab shows which one is in effect. Only `ghcr.io` repositories are supported — the
engine talks to GHCR's registry API for tag listing and drift detection.

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

## License

signalk-updater-server 1.0.0 and later is **source available, not open source**.
See [LICENSE.md](LICENSE.md).

**You may**, free of charge: run it on your own boat or fleet, private or
commercial; use it for internal company operations; modify it for your own use;
use it in education and research; and provide professional services around it.

**You may not**: redistribute it, or publish a modified version of it — as an
npm package, container image or otherwise. Verbatim copies of official releases
(including the published container images) may be mirrored and cached.

Versions 0.9.1 and earlier remain available under the Apache-2.0 license, see
[LICENSE-Apache-2.0-through-v0.x.txt](LICENSE-Apache-2.0-through-v0.x.txt).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
