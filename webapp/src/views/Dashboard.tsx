import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Badge,
  Button,
  ButtonGroup,
  Card,
  CardBody,
  CardHeader,
  Col,
  Row,
  Spinner,
} from 'reactstrap';
import { api, getApiBase } from '../api';
import { useApi } from '../hooks/useApi';
import { useToast } from '../toast';
import { useConfirm } from '../confirm';
import { fmtTime, relTime } from '../time';
import { mergeImageState } from '../image-state';
import type {
  AvailableUpdates,
  ChannelOrUnknown,
  ContainerSnapshot,
  CurrentState,
  DoctorState,
  DriftPackage,
  HealthResponse,
  ImageState,
  LockStatus,
  SelfState,
  SwitchProgressEvent,
} from '../types';

const STATE_COLOR: Record<ContainerSnapshot['state'], string> = {
  running: 'success',
  starting: 'warning',
  stopped: 'secondary',
  unhealthy: 'danger',
  missing: 'dark',
};

const CHANNEL_COLOR: Record<ChannelOrUnknown, string> = {
  stable: 'success',
  beta: 'warning',
  master: 'danger',
  dirkwa: 'info',
  unknown: 'secondary',
};

function StateBadge({ state }: { state: ContainerSnapshot['state'] }) {
  return <Badge color={STATE_COLOR[state] ?? 'secondary'}>{state}</Badge>;
}

function SnapshotRow({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children?: ReactNode;
}) {
  return (
    <div className="d-flex justify-content-between align-items-baseline mb-1 gap-2">
      <span className="text-muted small flex-shrink-0">{label}</span>
      <span
        className="text-end text-truncate"
        title={typeof value === 'string' ? value : undefined}
      >
        {children ?? value ?? '—'}
      </span>
    </div>
  );
}

/** Render the OperatorIntent channel as a `:tag (channel)` row.
 *  The Quadlet tag answers "what stream does the operator track" — a
 *  floating ref like `:latest` is the right value to show here, not a
 *  version string. The classifier-derived badge color tells the
 *  operator at a glance whether they're on the stable channel or a
 *  fork/dev channel. */
function ChannelCell({ tag, channel }: { tag: string; channel: ChannelOrUnknown }) {
  if (!tag || tag === 'unknown') return <>—</>;
  return (
    <span className="d-inline-flex align-items-baseline gap-2">
      <code className="small">:{tag}</code>
      <Badge color={CHANNEL_COLOR[channel] ?? 'secondary'} pill>
        {channel}
      </Badge>
    </span>
  );
}

function StartedCell({ startedAt }: { startedAt?: string }) {
  if (!startedAt) return <SnapshotRow label="Started" value="—" />;
  const rel = relTime(startedAt);
  return (
    <SnapshotRow
      label="Started"
      value={rel ? `${fmtTime(startedAt)} (${rel})` : fmtTime(startedAt)}
    />
  );
}

/** RuntimeIdentity row. Shows the engine's reported semver when
 *  knowable, falls back to a muted "—" so the operator sees the field
 *  exists but the engine couldn't answer (signalk-server with no
 *  OCI label, or a transient health-probe failure). */
function VersionCell({ version }: { version: string | null }) {
  if (version === null) return <span className="text-muted">—</span>;
  return <span className="font-monospace">{version}</span>;
}

/** Drift notice for a container card. Renders nothing when in-sync or
 *  unknown — only the actionable states earn the operator's attention.
 *  `onRestart` is wired for containers where a restart is the local fix
 *  (signalk-server has a Restart button; the engines self-restart on
 *  update). Pulls are always directed to the Versions tab. */
function ImageStateNotice({
  imageState,
  onRestart,
}: {
  imageState: ImageState;
  onRestart?: () => void;
}) {
  if (imageState === 'in-sync' || imageState === 'unknown') return null;
  const needsRestart = imageState === 'restart-required' || imageState === 'pull-and-restart';
  const needsPull = imageState === 'pull-available' || imageState === 'pull-and-restart';
  return (
    <Alert color="warning" className="mt-3 mb-0 py-2 px-3 small">
      <div className="fw-semibold mb-1">
        {imageState === 'restart-required'
          ? 'Restart required'
          : imageState === 'pull-available'
            ? 'Update available'
            : 'Update + restart needed'}
      </div>
      {needsPull ? (
        <div>
          A newer image for this tag is on the registry.{' '}
          <a href="#/versions">Update &amp; restart it on the Versions tab</a>.
        </div>
      ) : null}
      {needsRestart && !needsPull ? (
        <div>
          A newer image is already pulled but the container is still running the old one.
          {onRestart ? '' : ' Restart it to pick up the new image.'}
        </div>
      ) : null}
      {needsRestart && onRestart ? (
        <Button color="warning" size="sm" className="mt-2" onClick={onRestart}>
          Restart now
        </Button>
      ) : null}
    </Alert>
  );
}

/** Inline doctor-update progress, driven by the shared switch-progress
 *  SSE (filtered to target:'doctor'). Renders while an update is in
 *  flight from this tab OR while a non-terminal doctor event is the last
 *  thing the stream reported (so a tab opened mid-update still shows it).
 *  The terminal toast is handled by the Dashboard's SSE effect; this is
 *  just the live stage line. */
function DoctorUpdateProgress({
  event,
  active,
}: {
  event: SwitchProgressEvent | null;
  active: boolean;
}) {
  const terminal = event?.stage === 'complete' || event?.stage === 'failed';
  if (!active && (!event || terminal)) return null;
  const color = event?.stage === 'rolling-back' ? 'warning' : 'info';
  const label = event?.message ?? 'Updating…';
  return (
    <Alert color={color} className="mt-3 mb-0 py-2 px-3 small d-flex align-items-center">
      <Spinner size="sm" className="me-2" />
      <span className="text-truncate">{label}</span>
    </Alert>
  );
}

const CLASSIFICATION_COLOR: Record<DriftPackage['classification'], string> = {
  'up-to-date': 'success',
  patch: 'info',
  minor: 'warning',
  major: 'danger',
  prerelease: 'secondary',
  unknown: 'secondary',
};

function PinnedDepsSection({ updates }: { updates: AvailableUpdates | null }) {
  const drift = updates?.signalkDeps;
  if (!drift) return null;
  const drifting = drift.packages.filter((p) => p.classification !== 'up-to-date');
  // Quiet UI: only render when something is actually drifting. Up-to-date
  // packages don't earn the operator's attention.
  if (drifting.length === 0) return null;
  const lastChecked = drift.lastSuccessfulScanAt
    ? relTime(drift.lastSuccessfulScanAt)
    : 'never (offline since boot)';
  return (
    <div className="mt-3 pt-3 border-top">
      <div className="d-flex justify-content-between align-items-baseline mb-2">
        <span className="text-muted small">Pinned dependencies</span>
        <span className="text-muted small">
          {drifting.length} {drifting.length === 1 ? 'update' : 'updates'}
        </span>
      </div>
      {drifting.map((p) => (
        <div
          key={p.name}
          className="d-flex justify-content-between align-items-baseline mb-1 small"
        >
          <span className="font-monospace text-truncate me-2" title={p.name}>
            {p.name}
          </span>
          <span className="d-flex align-items-baseline gap-2">
            <span className="text-muted">
              {p.installed} → {p.latest ?? '?'}
            </span>
            <Badge color={CLASSIFICATION_COLOR[p.classification] ?? 'secondary'} pill>
              {p.classification}
            </Badge>
          </span>
        </div>
      ))}
      <p className="text-muted small mb-0 mt-2">Last checked: {lastChecked}</p>
    </div>
  );
}

export function Dashboard() {
  const toast = useToast();
  const confirm = useConfirm();

  const state = useApi<CurrentState>((signal) => api('/api/state', { signal }), {
    intervalMs: 5000,
  });
  const health = useApi<HealthResponse>((signal) => api('/api/health', { signal }), {
    intervalMs: 15000,
  });
  const self = useApi<SelfState>((signal) => api('/api/self/state', { signal }), {
    intervalMs: 30000,
  });
  const doctor = useApi<DoctorState>((signal) => api('/api/doctor/state', { signal }), {
    intervalMs: 30000,
  });
  const updates = useApi<AvailableUpdates>((signal) => api('/api/updates/available', { signal }), {
    intervalMs: 5 * 60 * 1000,
  });
  // Operation-lock status. Surfaces an in-flight switch/update and, more
  // importantly, a STALE lock (a crashed operation that never released)
  // that would otherwise wedge every update button with silent 409s.
  const lock = useApi<LockStatus>((signal) => api('/api/lock', { signal }), {
    intervalMs: 10000,
  });

  // True while POST /api/doctor/update is in flight from THIS tab. The
  // doctor update is a single long POST (pull + restart + up-to-180s
  // health-poll); without an in-flight guard the button stays pressable
  // and a second click races the mutex into a 409. Also: behind the
  // embedded plugin proxy the long POST can time out into a 502 while the
  // switch keeps running server-side — so we drive the real outcome off
  // the SSE progress stream (below), not this POST's response.
  const [doctorUpdating, setDoctorUpdating] = useState(false);
  const [doctorProgress, setDoctorProgress] = useState<SwitchProgressEvent | null>(null);

  // Refs so the SSE handler can refresh the polled views on a terminal
  // event without re-subscribing every render.
  const doctorRef = useRef(doctor);
  doctorRef.current = doctor;
  const stateRef = useRef(state);
  stateRef.current = state;
  const updatesRef = useRef(updates);
  updatesRef.current = updates;
  const lockRef = useRef(lock);
  lockRef.current = lock;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // Subscribe to the shared switch-progress SSE, filtered to the doctor.
  // The broker replays its last event on connect, so a tab opened
  // mid-update picks up the in-flight stage. On a terminal event we
  // refresh the doctor/state/updates/lock views so the card and button
  // settle to the truth regardless of what the POST response did.
  useEffect(() => {
    const es = new EventSource(`${getApiBase()}/api/versions/switch/stream`);
    es.onmessage = (ev: MessageEvent<string>) => {
      let parsed: SwitchProgressEvent;
      try {
        parsed = JSON.parse(ev.data) as SwitchProgressEvent;
      } catch {
        return;
      }
      if (parsed.target !== 'doctor') return;
      setDoctorProgress(parsed);
      if (parsed.stage === 'complete' || parsed.stage === 'failed') {
        setDoctorUpdating(false);
        if (parsed.stage === 'complete') {
          toastRef.current.show(`signalk-doctor-server updated to ${parsed.to ?? ''}`.trim(), 'ok');
        } else {
          toastRef.current.show(`Doctor update failed: ${parsed.error ?? 'unknown'}`, 'err', 8000);
        }
        void doctorRef.current.refresh();
        void stateRef.current.refresh();
        void updatesRef.current.refresh();
        void lockRef.current.refresh();
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects on transient drops; nothing to do but
      // note it. The terminal outcome also has the POST-error safety net,
      // so a brief stream gap doesn't strand the user.

      console.debug('SSE switch-progress stream reconnecting…');
    };
    return () => es.close();
  }, []);

  // Mount flag so the doctor-update safety timeout can't setState after
  // unmount (it fires up to ~200s later).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // True while `POST /api/updates/check` is in flight. The endpoint can
  // take 20–60s on a slow VM (sequential per-tag manifest fetches against
  // GHCR), well past the 4s toast lifetime — without this, the
  // "Checking…" toast auto-dismisses and the user sees nothing happening
  // for ~30s. Disables the Check-now button + shows an inline spinner
  // so it's obvious the request is alive.
  const [isChecking, setIsChecking] = useState(false);

  /** Manual cache refresh — POSTs /api/updates/check which busts the
   *  in-memory cache and refires the GHCR probe. The escape hatch for
   *  the publish-day window even when invalidate-on-update didn't fire
   *  (e.g. release was on a different host). Also re-pulls state /
   *  health / self / doctor so the whole dashboard reflects the result
   *  without waiting for the next polling tick — this replaces the
   *  separate "Refresh" button. */
  const checkNow = useCallback(async (): Promise<void> => {
    if (isChecking) return;
    setIsChecking(true);
    try {
      toast.show('Checking for updates…', 'info');
      await api('/api/updates/check', { method: 'POST' });
      await Promise.all([
        state.refresh(),
        health.refresh(),
        self.refresh(),
        doctor.refresh(),
        updates.refresh(),
      ]);
      toast.show('Update check complete', 'ok');
    } catch (err) {
      toast.show(
        `Update check failed: ${err instanceof Error ? err.message : String(err)}`,
        'err',
        6000,
      );
    } finally {
      setIsChecking(false);
    }
  }, [isChecking, toast, state, health, self, doctor, updates]);

  const lifecycle = useCallback(
    async (action: 'start' | 'stop' | 'restart'): Promise<void> => {
      const verb = action.charAt(0).toUpperCase() + action.slice(1);
      if (action === 'stop' || action === 'restart') {
        const r = await confirm.ask({
          title: `${verb} signalk-server?`,
          body: `This will ${action} the signalk-server container. Plotters, AIS feeds, and instruments will be ${action === 'restart' ? 'briefly ' : ''}disconnected.`,
          okLabel: verb,
          okColor: action === 'stop' ? 'danger' : 'primary',
        });
        if (!r.confirmed) return;
      }
      try {
        toast.show(`${verb}ing signalk-server…`, 'info');
        await api(`/api/signalk/${action}`, { method: 'POST' });
        toast.show(`${verb} request sent`, 'ok');
        setTimeout(() => void state.refresh(), 1500);
      } catch (err) {
        toast.show(`${verb} failed: ${err instanceof Error ? err.message : String(err)}`, 'err');
      }
    },
    [confirm, state, toast],
  );

  const selfUpdate = useCallback(async (): Promise<void> => {
    const tag = self.data?.availableTag;
    if (!tag) return;
    const r = await confirm.ask({
      title: `Self-update to ${tag}?`,
      body: 'The updater will pull the new image and restart. The browser will lose its connection for ~30s; refresh the page once it returns. signalk-server is not touched.',
      okLabel: 'Update',
    });
    if (!r.confirmed) return;
    try {
      toast.show(`Self-updating to ${tag}…`, 'info', 30000);
      await api('/api/self/update', { method: 'POST', body: { tag } });
      toast.show('Self-update kicked off — wait for restart', 'ok');
    } catch (err) {
      toast.show(
        `Self-update failed: ${err instanceof Error ? err.message : String(err)}`,
        'err',
        8000,
      );
    }
  }, [confirm, self.data?.availableTag, toast]);

  const doctorUpdate = useCallback(async (): Promise<void> => {
    const tag = doctor.data?.availableTag;
    if (!tag || doctorUpdating) return;
    const r = await confirm.ask({
      title: `Update signalk-doctor-server to ${tag}?`,
      body: 'The updater will pull the new image, restart the doctor, and roll back if it does not come up healthy. The doctor is the recovery surface, so this is the safe place to drive the update from.',
      okLabel: 'Update',
    });
    if (!r.confirmed) return;
    setDoctorUpdating(true);
    setDoctorProgress(null);
    try {
      toast.show(`Updating signalk-doctor-server to ${tag}…`, 'info', 60000);
      // The success/failure toast + state refresh is driven by the SSE
      // terminal event (see the effect above), NOT this response: behind
      // the embedded proxy the long POST can 502 while the switch is still
      // running, and the stream is the reliable outcome signal. We still
      // await it to surface a synchronous error (e.g. 409 mutex-busy) the
      // stream wouldn't carry.
      await api('/api/doctor/update', { method: 'POST', body: { tag } });
    } catch (err) {
      // A 502/timeout here is expected when the proxy gives up on the long
      // POST — the SSE stream will still deliver the real result, so only
      // clear the in-flight state on a definite non-progress error and let
      // the user see it. Refresh lock/doctor so a mutex 409 or a
      // partially-applied switch is reflected immediately.
      const msg = err instanceof Error ? err.message : String(err);
      toast.show(`Doctor update: ${msg} (watching progress…)`, 'err', 8000);
      void lock.refresh();
      void doctor.refresh();
      // Safety net: if no SSE terminal event arrives within the health
      // window, stop showing the button as busy so the user isn't stuck.
      // Guard against firing after unmount.
      setTimeout(() => {
        if (mountedRef.current) setDoctorUpdating(false);
      }, 200000);
    }
  }, [confirm, doctor, doctorUpdating, lock, toast]);

  const clearLock = useCallback(async (): Promise<void> => {
    try {
      await api('/api/lock/clear', { method: 'POST' });
      toast.show('Operation lock cleared', 'ok');
      await Promise.all([lock.refresh(), doctor.refresh(), state.refresh()]);
    } catch (err) {
      toast.show(
        `Could not clear lock: ${err instanceof Error ? err.message : String(err)}`,
        'err',
        6000,
      );
    }
  }, [lock, doctor, state, toast]);

  const lastChecked = updates.data?.lastCheckedAt ? relTime(updates.data.lastCheckedAt) : 'never';

  return (
    <>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h2 className="mb-0">Dashboard</h2>
        <Button
          color="primary"
          outline
          size="sm"
          onClick={() => void checkNow()}
          disabled={isChecking}
        >
          {isChecking ? (
            <>
              <Spinner size="sm" className="me-2" />
              Checking…
            </>
          ) : (
            'Check now'
          )}
        </Button>
      </div>

      {state.error !== null ? (
        <Alert color="danger" className="mb-3">
          Failed to load state: {state.error}
        </Alert>
      ) : null}

      {lock.data?.stale && lock.data.lock ? (
        <Alert color="warning" className="mb-3 d-flex justify-content-between align-items-center">
          <span>
            An operation lock from <code>{lock.data.lock.operation}</code> has been held since{' '}
            {relTime(lock.data.lock.startedAt)} — most likely a crashed update that never released.
            It is blocking new switches and updates.
          </span>
          <Button
            color="warning"
            size="sm"
            className="ms-3 flex-shrink-0"
            onClick={() => void clearLock()}
          >
            Clear lock
          </Button>
        </Alert>
      ) : null}

      <Row>
        <Col xs={12} lg={4} className="mb-3">
          <Card>
            <CardHeader className="d-flex justify-content-between align-items-center">
              <strong>SignalK Server</strong>
              {state.data ? (
                <StateBadge state={state.data.signalkServer.state} />
              ) : (
                <Spinner size="sm" />
              )}
            </CardHeader>
            <CardBody>
              {state.data ? (
                <>
                  <SnapshotRow label="Version">
                    <VersionCell version={state.data.signalkServer.version} />
                  </SnapshotRow>
                  <SnapshotRow label="Channel">
                    <ChannelCell
                      tag={state.data.signalkServer.tag}
                      channel={state.data.signalkServer.channel}
                    />
                  </SnapshotRow>
                  <StartedCell startedAt={state.data.signalkServer.startedAt} />
                  <PinnedDepsSection updates={updates.data} />
                  <ImageStateNotice
                    imageState={mergeImageState(
                      state.data.signalkServer.imageState,
                      updates.data?.signalkServer.imageState,
                    )}
                    onRestart={() => void lifecycle('restart')}
                  />
                </>
              ) : (
                <Spinner size="sm" />
              )}
            </CardBody>
            <div className="card-footer">
              <ButtonGroup size="sm">
                <Button color="primary" outline onClick={() => void lifecycle('start')}>
                  Start
                </Button>
                <Button color="primary" outline onClick={() => void lifecycle('restart')}>
                  Restart
                </Button>
                <Button color="danger" outline onClick={() => void lifecycle('stop')}>
                  Stop
                </Button>
              </ButtonGroup>
            </div>
          </Card>
        </Col>

        <Col xs={12} lg={4} className="mb-3">
          <Card>
            <CardHeader className="d-flex justify-content-between align-items-center">
              <strong>Updater</strong>
              {state.data ? (
                <StateBadge state={state.data.updaterServer.state} />
              ) : (
                <Spinner size="sm" />
              )}
            </CardHeader>
            <CardBody>
              {state.data ? (
                <>
                  <SnapshotRow label="Version">
                    <VersionCell version={state.data.updaterServer.version} />
                  </SnapshotRow>
                  <SnapshotRow label="Channel">
                    <ChannelCell
                      tag={state.data.updaterServer.tag}
                      channel={state.data.updaterServer.channel}
                    />
                  </SnapshotRow>
                  <StartedCell startedAt={state.data.updaterServer.startedAt} />
                  <SnapshotRow
                    label="Update"
                    value={
                      self.data?.updateAvailable && self.data.availableTag
                        ? `Available: ${self.data.availableTag}`
                        : self.data
                          ? 'Up to date'
                          : '—'
                    }
                  />
                  <SnapshotRow label="Last checked" value={lastChecked} />
                  <ImageStateNotice
                    imageState={mergeImageState(
                      state.data.updaterServer.imageState,
                      updates.data?.updater.imageState,
                    )}
                  />
                </>
              ) : (
                <Spinner size="sm" />
              )}
            </CardBody>
            <div className="card-footer">
              <Button
                size="sm"
                color="primary"
                disabled={!self.data?.updateAvailable}
                onClick={() => void selfUpdate()}
              >
                Self-update
              </Button>
            </div>
          </Card>
        </Col>

        <Col xs={12} lg={4} className="mb-3">
          <Card>
            <CardHeader className="d-flex justify-content-between align-items-center">
              <strong>Doctor</strong>
              {state.data ? (
                <StateBadge state={state.data.doctorServer.state} />
              ) : (
                <Spinner size="sm" />
              )}
            </CardHeader>
            <CardBody>
              {state.data ? (
                <>
                  <SnapshotRow label="Version">
                    <VersionCell version={state.data.doctorServer.version} />
                  </SnapshotRow>
                  <SnapshotRow label="Channel">
                    <ChannelCell
                      tag={state.data.doctorServer.tag}
                      channel={state.data.doctorServer.channel}
                    />
                  </SnapshotRow>
                  <StartedCell startedAt={state.data.doctorServer.startedAt} />
                  <SnapshotRow
                    label="Update"
                    value={
                      doctor.data?.updateAvailable && doctor.data.availableTag
                        ? `Available: ${doctor.data.availableTag}`
                        : doctor.data
                          ? 'Up to date'
                          : '—'
                    }
                  />
                  <SnapshotRow label="Last checked" value={lastChecked} />
                  <ImageStateNotice
                    imageState={mergeImageState(
                      state.data.doctorServer.imageState,
                      updates.data?.doctor.imageState,
                    )}
                  />
                  <DoctorUpdateProgress event={doctorProgress} active={doctorUpdating} />
                </>
              ) : (
                <Spinner size="sm" />
              )}
            </CardBody>
            <div className="card-footer">
              <Button
                size="sm"
                color="primary"
                disabled={!doctor.data?.updateAvailable || doctorUpdating}
                onClick={() => void doctorUpdate()}
              >
                {doctorUpdating ? (
                  <>
                    <Spinner size="sm" className="me-2" />
                    Updating…
                  </>
                ) : (
                  'Update'
                )}
              </Button>
            </div>
          </Card>
        </Col>
      </Row>

      <p className="text-muted small mt-2">
        Last state poll:{' '}
        {state.data ? `${fmtTime(state.data.lastCheck)} (${relTime(state.data.lastCheck)})` : '—'}
        {' · '}
        Runtime: {health.data?.runtime ?? (health.loading ? 'loading…' : 'unreachable')}
        {health.data?.runtimeVersion ? ` ${health.data.runtimeVersion}` : ''}
      </p>
    </>
  );
}
