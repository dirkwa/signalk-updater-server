import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Form,
  Input,
  Label,
  Progress,
  Spinner,
  Table,
} from 'reactstrap';
import { api, getApiBase } from '../api';
import { useApi } from '../hooks/useApi';
import { useToast } from '../toast';
import { useConfirm } from '../confirm';
import { fmtTime, relTime } from '../time';
import { mergeImageState } from '../image-state';
import type {
  AnnotatedTag,
  AvailableUpdates,
  Channel,
  CurrentState,
  ImageState,
  SwitchProgressEvent,
  VersionSettings,
  VersionsResponse,
} from '../types';

const CHANNEL_ORDER: Channel[] = ['stable', 'beta', 'master', 'dirkwa'];

const CHANNEL_DESCRIPTIONS: Record<Channel, string> = {
  stable: 'Production releases — long-tested, recommended for boats in use.',
  beta: 'Pre-release builds — newer features, may have rough edges.',
  master: 'Bleeding edge from the master branch — every commit on signalk-server/main.',
  dirkwa: 'Custom builds maintained in dirkwa/signalk-server.',
};

const STAGE_LABELS: Record<SwitchProgressEvent['stage'], string> = {
  idle: 'Idle',
  pulling: 'Pulling image',
  trial: 'Trial run',
  'rewriting-quadlet': 'Rewriting Quadlet',
  'daemon-reload': 'Reloading systemd',
  restarting: 'Restarting',
  'health-poll': 'Waiting for healthy',
  'rolling-back': 'Rolling back',
  complete: 'Complete',
  failed: 'Failed',
};

// Coarse progress estimate per stage — gives the bar something to move
// against while the actual flow advances. The pull stage is the
// long-tail outlier (~10s of MB over LTE) so it dominates the curve.
const STAGE_PROGRESS: Record<SwitchProgressEvent['stage'], number> = {
  idle: 0,
  pulling: 25,
  trial: 50,
  'rewriting-quadlet': 60,
  'daemon-reload': 65,
  restarting: 70,
  'health-poll': 90,
  'rolling-back': 95,
  complete: 100,
  failed: 100,
};

const ACTIVE_STAGES: ReadonlySet<SwitchProgressEvent['stage']> = new Set([
  'pulling',
  'trial',
  'rewriting-quadlet',
  'daemon-reload',
  'restarting',
  'health-poll',
  'rolling-back',
]);

const MAX_VISIBLE_PER_CHANNEL = 25;

function shortDigest(digest: string): string {
  const hex = digest.includes(':') ? digest.slice(digest.indexOf(':') + 1) : digest;
  return hex.slice(0, 12);
}

/** The in-use row's image is stale (registry moved and/or a pulled image
 *  isn't running yet) — i.e. there's an actionable update for the tag the
 *  operator already tracks. `in-sync` / `unknown` are not drift: keep the
 *  inert "In use" rendering for those. */
function isDrift(imageState: ImageState): boolean {
  return (
    imageState === 'pull-available' ||
    imageState === 'pull-and-restart' ||
    imageState === 'restart-required'
  );
}

function isChannelVisible(channel: Channel, settings: VersionSettings | null): boolean {
  if (channel === 'stable' || channel === 'dirkwa') return true;
  if (channel === 'beta') return settings?.showBeta ?? false;
  if (channel === 'master') return settings?.showMaster ?? false;
  return true;
}

// A transient registry blip (server maps network / registry-unavailable to
// a "temporarily unavailable" / "could not reach" userMessage) reads as
// "try again", not a hard failure — common on boat LTE links. Render it
// as a calm warning with a Retry button. Anything else stays a danger
// alert. We key off the message phrasing because useApi surfaces only the
// message string, and that string now carries the retryable wording.
function isTransientRegistryError(message: string): boolean {
  return /temporarily unavailable|could not reach the registry/i.test(message);
}

function TagFetchError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const transient = isTransientRegistryError(message);
  return (
    <Alert
      color={transient ? 'warning' : 'danger'}
      className="d-flex justify-content-between align-items-center"
    >
      <span>{transient ? message : `Failed to fetch tags: ${message}`}</span>
      <Button
        size="sm"
        color={transient ? 'warning' : 'danger'}
        outline
        className="ms-3 flex-shrink-0"
        onClick={onRetry}
      >
        Retry
      </Button>
    </Alert>
  );
}

export function Versions() {
  const toast = useToast();
  const confirm = useConfirm();

  const versions = useApi<VersionsResponse>((signal) => api('/api/versions', { signal }));
  const state = useApi<CurrentState>((signal) => api('/api/state', { signal }), {
    intervalMs: 5000,
  });
  const settings = useApi<VersionSettings>((signal) => api('/api/versions/settings', { signal }));
  // Image-level freshness for signalk-server's movable tag (`:dirkwa`,
  // `:master`, `:latest`). For these tags the semver never moves between
  // builds, so a digest-derived imageState is the only honest "is the
  // in-use tag actually current" signal — the in-use row uses it to offer
  // "Update & restart" instead of an inert "In use". Same source the
  // Dashboard banner reads.
  const updates = useApi<AvailableUpdates>((signal) => api('/api/updates/available', { signal }), {
    intervalMs: 5 * 60 * 1000,
  });

  const [progress, setProgress] = useState<SwitchProgressEvent | null>(null);
  const [pullingTag, setPullingTag] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Refs around versions/state so the SSE handler can refresh them
  // when a switch completes WITHOUT re-subscribing on every render.
  // We want one EventSource for the component's lifetime, not a
  // reconnect per refresh tick.
  const versionsRef = useRef(versions);
  versionsRef.current = versions;
  const stateRef = useRef(state);
  stateRef.current = state;
  const updatesRef = useRef(updates);
  updatesRef.current = updates;
  // So the SSE handler can clear the in-flight Pull spinner on the
  // terminal event (a background pull streams over the same channel).
  const pullingTagRef = useRef<string | null>(null);
  // True when a switch was kicked off from THIS tab, so the SSE handler
  // toasts its terminal outcome (the 202 response no longer carries it).
  const switchInitiatedRef = useRef(false);
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // Open one persistent SSE channel so the progress card reflects any
  // in-flight switch, even one another browser kicked off. The broker
  // emits its lastEvent immediately on connect, so reloading the tab
  // mid-flow picks the state right back up.
  useEffect(() => {
    const es = new EventSource(`${getApiBase()}/api/versions/switch/stream`);
    eventSourceRef.current = es;
    es.onmessage = (ev: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(ev.data) as SwitchProgressEvent;
        setProgress(parsed);
        if (parsed.stage === 'complete' || parsed.stage === 'failed') {
          // Refresh the version list + state so the "in use" badge and
          // isLocal flags catch up. Also refresh the updates cache so the
          // in-use row's drift action clears once the new digest is
          // running (the in-memory cache is busted server-side on a
          // successful switch, but the webapp still needs to re-read it).
          void versionsRef.current.refresh();
          void stateRef.current.refresh();
          void updatesRef.current.refresh();
          // A background pull streams over this same channel. If one was in
          // flight from this tab, clear its spinner and report the outcome
          // (the POST returned 202 immediately, so the result only arrives
          // here, never on the request promise).
          if (pullingTagRef.current !== null) {
            const tag = pullingTagRef.current;
            pullingTagRef.current = null;
            setPullingTag(null);
            if (parsed.stage === 'complete') {
              toastRef.current.show(`Pulled ${tag}`, 'ok');
            } else {
              toastRef.current.show(`Pull failed: ${parsed.error ?? 'unknown error'}`, 'err', 8000);
            }
          } else if (switchInitiatedRef.current) {
            // A switch kicked off from this tab finished. The 202 response
            // didn't carry the outcome, so report it here.
            switchInitiatedRef.current = false;
            if (parsed.stage === 'complete') {
              toastRef.current.show(`Switched to ${parsed.to ?? ''}`.trim(), 'ok');
            } else {
              toastRef.current.show(
                `Switch failed: ${parsed.error ?? 'unknown error'}`,
                'err',
                8000,
              );
            }
          }
        }
      } catch {
        // ignore malformed events; heartbeats arrive as `: heartbeat` and
        // don't trigger onmessage at all.
      }
    };
    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, []);

  const refreshFromRegistry = useCallback(async (): Promise<void> => {
    try {
      const fresh = await api<VersionsResponse>('/api/versions/check', { method: 'POST' });
      await versions.refresh();
      toast.show(`Fetched ${countTags(fresh)} tags from GHCR`, 'ok');
    } catch (err) {
      toast.show(
        `Refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        'err',
        6000,
      );
    }
  }, [toast, versions]);

  const toggleSetting = useCallback(
    async (key: 'showBeta' | 'showMaster', value: boolean): Promise<void> => {
      try {
        await api<VersionSettings>('/api/versions/settings', {
          method: 'PUT',
          body: { [key]: value },
        });
        await settings.refresh();
      } catch (err) {
        toast.show(
          `Could not save setting: ${err instanceof Error ? err.message : String(err)}`,
          'err',
          6000,
        );
      }
    },
    [settings, toast],
  );

  const doPull = useCallback(
    async (tag: string): Promise<void> => {
      setPullingTag(tag);
      pullingTagRef.current = tag;
      try {
        // Returns 202 immediately; the pull runs server-side and streams
        // progress + the terminal result over the switch-progress SSE. The
        // spinner is cleared and the outcome toasted by the SSE handler, NOT
        // here — a full image pull takes minutes and the embedded proxy
        // would 502 a blocking request. We only handle a synchronous
        // dispatch failure (bad request / engine unreachable).
        await api('/api/versions/pull', { method: 'POST', body: { tag } });
        toast.show(`Pulling ${tag}… (progress below)`, 'info');
      } catch (err) {
        pullingTagRef.current = null;
        setPullingTag(null);
        toast.show(
          `Could not start pull: ${err instanceof Error ? err.message : String(err)}`,
          'err',
          8000,
        );
      }
    },
    [toast],
  );

  const doSwitch = useCallback(
    async (tag: string): Promise<void> => {
      const r = await confirm.ask({
        title: `Switch to ${tag}?`,
        body: 'signalk-server will be stopped, the new image pulled (if not already cached), and the container restarted on the new tag. A pre-switch backup runs if signalk-backup is installed. Estimated downtime: 30–90s.',
        okLabel: 'Switch',
        showSkipBackup: true,
      });
      if (!r.confirmed) return;
      try {
        // Returns 202 immediately; the switch runs server-side and streams
        // stages over the SSE channel (rendered by the progress card). The
        // terminal outcome toast + refresh are handled by the SSE handler,
        // NOT here — a blocking request would 502 through the embedded
        // proxy mid-switch. We only handle a synchronous dispatch failure.
        switchInitiatedRef.current = true;
        toast.show(`Switching to ${tag}… (progress below)`, 'info');
        await api('/api/versions/switch', {
          method: 'POST',
          body: { tag, skipBackup: r.skipBackup },
        });
      } catch (err) {
        switchInitiatedRef.current = false;
        toast.show(
          `Could not start switch: ${err instanceof Error ? err.message : String(err)}`,
          'err',
          8000,
        );
      }
    },
    [confirm, toast],
  );

  const currentTag = state.data?.signalkServer.tag ?? null;
  // Digest-level freshness of the in-use tag. Merges the instant,
  // network-free signal from /api/state with the GHCR-cadence signal from
  // /api/updates/available (the only one that ever reports
  // 'pull-available'). Drives the in-use row's "Update & restart" /
  // "Restart to apply" action for movable tags.
  const currentImageState: ImageState = mergeImageState(
    state.data?.signalkServer.imageState,
    updates.data?.signalkServer.imageState,
  );
  const switchInFlight = progress !== null && ACTIVE_STAGES.has(progress.stage);

  return (
    <>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <div>
          <h2 className="mb-0">Versions</h2>
          {versions.data ? (
            <p className="text-muted small mb-0">
              Last fetched: {fmtTime(versions.data.cachedAt)} ({relTime(versions.data.cachedAt)})
            </p>
          ) : null}
        </div>
        <Button
          size="sm"
          color="secondary"
          outline
          disabled={versions.loading}
          onClick={() => void refreshFromRegistry()}
        >
          Refresh from GHCR
        </Button>
      </div>

      <Form className="mb-3 d-flex flex-wrap gap-3">
        <FormCheck
          id="showBeta"
          label="Show beta builds"
          checked={settings.data?.showBeta ?? false}
          onChange={(v) => void toggleSetting('showBeta', v)}
        />
        <FormCheck
          id="showMaster"
          label="Show development builds (master)"
          checked={settings.data?.showMaster ?? false}
          onChange={(v) => void toggleSetting('showMaster', v)}
        />
      </Form>

      {progress !== null && progress.stage !== 'idle' ? <ProgressCard event={progress} /> : null}

      {versions.error !== null ? (
        <TagFetchError message={versions.error} onRetry={() => void refreshFromRegistry()} />
      ) : null}

      {versions.loading && !versions.data ? <Spinner /> : null}

      {versions.data
        ? CHANNEL_ORDER.map((channel) => {
            if (!isChannelVisible(channel, settings.data)) return null;
            const tags = versions.data?.channels[channel] ?? [];
            if (tags.length === 0) return null;
            return (
              <ChannelCard
                key={channel}
                channel={channel}
                tags={tags}
                currentTag={currentTag}
                currentImageState={currentImageState}
                pullingTag={pullingTag}
                switchInFlight={switchInFlight}
                onPull={doPull}
                onSwitch={doSwitch}
              />
            );
          })
        : null}
    </>
  );
}

interface FormCheckProps {
  id: string;
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}

function FormCheck({ id, label, checked, onChange }: FormCheckProps) {
  return (
    <div className="form-check">
      <Input
        type="checkbox"
        id={id}
        className="form-check-input"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <Label for={id} className="form-check-label">
        {label}
      </Label>
    </div>
  );
}

function ProgressCard({ event }: { event: SwitchProgressEvent }) {
  const isError = event.stage === 'failed' || event.stage === 'rolling-back';
  const color =
    event.stage === 'complete'
      ? 'success'
      : event.stage === 'failed'
        ? 'danger'
        : event.stage === 'rolling-back'
          ? 'warning'
          : 'info';
  return (
    <Card className="mb-3">
      <CardHeader className="d-flex justify-content-between align-items-center">
        <strong>Switch progress</strong>
        <Badge color={color}>{STAGE_LABELS[event.stage]}</Badge>
      </CardHeader>
      <CardBody>
        <p className="mb-2">
          {event.message ?? STAGE_LABELS[event.stage]}
          {event.to ? <span className="text-muted ms-2">→ {event.to}</span> : null}
        </p>
        <Progress
          animated={ACTIVE_STAGES.has(event.stage)}
          color={color}
          value={STAGE_PROGRESS[event.stage]}
        />
        {isError && event.error ? (
          <Alert color="danger" className="mt-2 mb-0">
            {event.error}
          </Alert>
        ) : null}
      </CardBody>
    </Card>
  );
}

function countTags(v: VersionsResponse): number {
  return CHANNEL_ORDER.reduce((n, c) => n + (v.channels[c]?.length ?? 0), 0);
}

interface ChannelCardProps {
  channel: Channel;
  tags: AnnotatedTag[];
  currentTag: string | null;
  currentImageState: ImageState;
  pullingTag: string | null;
  switchInFlight: boolean;
  onPull: (tag: string) => void;
  onSwitch: (tag: string) => void;
}

function ChannelCard({
  channel,
  tags,
  currentTag,
  currentImageState,
  pullingTag,
  switchInFlight,
  onPull,
  onSwitch,
}: ChannelCardProps) {
  const visible = tags.slice(0, MAX_VISIBLE_PER_CHANNEL);
  const overflow = tags.length - visible.length;
  return (
    <Card className="mb-3">
      <CardHeader className="d-flex justify-content-between align-items-center">
        <div>
          <strong className="text-capitalize">{channel}</strong>
          <span className="text-muted small ms-2">{CHANNEL_DESCRIPTIONS[channel]}</span>
        </div>
        <Badge color="light" className="border text-dark">
          {tags.length} {tags.length === 1 ? 'tag' : 'tags'}
        </Badge>
      </CardHeader>
      <CardBody className="p-0">
        <Table size="sm" responsive className="mb-0 align-middle">
          <thead>
            <tr>
              <th>Tag</th>
              <th className="d-none d-md-table-cell">Published</th>
              <th className="d-none d-md-table-cell">Digest</th>
              <th>Cache</th>
              <th className="text-end" style={{ width: '10rem' }}>
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((t) => {
              const isCurrent = t.name === currentTag;
              const isLocal = t.isLocal === true;
              const isPulling = pullingTag === t.name;
              return (
                <tr key={t.name}>
                  <td>
                    <span className="me-2">{t.name}</span>
                    {isCurrent ? <Badge color="primary">current</Badge> : null}
                    {isCurrent && isDrift(currentImageState) ? (
                      <div className="text-warning small mt-1">
                        {currentImageState === 'restart-required'
                          ? 'Newer image pulled — restart to apply'
                          : 'Newer image on registry for this tag'}
                      </div>
                    ) : null}
                  </td>
                  <td className="d-none d-md-table-cell text-muted small">
                    {t.pushedAt ? fmtTime(t.pushedAt) : '—'}
                  </td>
                  <td className="d-none d-md-table-cell">
                    <code className="small" title={t.digest}>
                      {shortDigest(t.digest)}
                    </code>
                  </td>
                  <td>
                    {isLocal ? (
                      <Badge color="info">Local</Badge>
                    ) : (
                      <Badge color="secondary">Remote</Badge>
                    )}
                  </td>
                  <td className="text-end">
                    {isCurrent ? (
                      <CurrentRowAction
                        tag={t.name}
                        imageState={currentImageState}
                        switchInFlight={switchInFlight}
                        onSwitch={onSwitch}
                      />
                    ) : isLocal ? (
                      <Button
                        size="sm"
                        color="primary"
                        outline
                        disabled={switchInFlight}
                        onClick={() => onSwitch(t.name)}
                      >
                        Switch
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        color="secondary"
                        outline
                        disabled={isPulling || switchInFlight}
                        onClick={() => onPull(t.name)}
                      >
                        {isPulling ? (
                          <>
                            <Spinner size="sm" /> Pulling…
                          </>
                        ) : (
                          'Pull'
                        )}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
            {overflow > 0 ? (
              <tr>
                <td colSpan={5} className="text-muted small text-center">
                  … and {overflow} older {channel} {overflow === 1 ? 'tag' : 'tags'}.
                </td>
              </tr>
            ) : null}
          </tbody>
        </Table>
      </CardBody>
    </Card>
  );
}

/** Action cell for the in-use tag row. When the in-use image is current
 *  this is the inert "In use" text. When the registry has moved the
 *  movable tag (or a pulled image hasn't been started yet) it becomes an
 *  actionable button that runs the full switch flow against the SAME tag:
 *  re-pull the moved digest → trial → rewrite Quadlet → restart →
 *  health-poll → rollback on failure. Switching to the same tag name is a
 *  Quadlet no-op but a real image upgrade — this is the only way to "pull
 *  & run the latest" for `:dirkwa` / `:master` / `:latest`, where the
 *  semver never moves between builds. */
function CurrentRowAction({
  tag,
  imageState,
  switchInFlight,
  onSwitch,
}: {
  tag: string;
  imageState: ImageState;
  switchInFlight: boolean;
  onSwitch: (tag: string) => void;
}) {
  if (!isDrift(imageState)) {
    return <span className="text-muted small">In use</span>;
  }
  // `restart-required` only needs a restart, but routing it through the
  // same switch flow (which re-pulls the already-current digest, a no-op,
  // then restarts) keeps one code path, one confirm dialog, and the same
  // rollback safety net. The label tells the operator which case it is.
  const label = imageState === 'restart-required' ? 'Restart to apply' : 'Update & restart';
  return (
    <Button size="sm" color="warning" disabled={switchInFlight} onClick={() => onSwitch(tag)}>
      {label}
    </Button>
  );
}
