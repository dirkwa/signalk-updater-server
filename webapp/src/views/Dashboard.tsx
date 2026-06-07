import { useCallback, useState, type ReactNode } from 'react';
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
import { api } from '../api';
import { useApi } from '../hooks/useApi';
import { useToast } from '../toast';
import { useConfirm } from '../confirm';
import { fmtTime, relTime } from '../time';
import type {
  AvailableUpdates,
  ChannelOrUnknown,
  ContainerSnapshot,
  CurrentState,
  DoctorState,
  DriftPackage,
  HealthResponse,
  ImageState,
  SelfState,
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

/** Combine the two image-state signals into the one to display.
 *  `/api/state` is the instant, network-free signal (so it carries
 *  'restart-required' the moment a pull happens), while
 *  `/api/updates/available` is refreshed on the GHCR cadence (so it's the
 *  only one that ever reports 'pull-available'). When they disagree, take
 *  the union: a tag can have moved on GHCR (pull-available, from updates)
 *  AND have a pulled-but-not-restarted image (restart-required, from
 *  state) at the same time → 'pull-and-restart'. */
export function mergeImageState(
  fromState: ImageState | undefined,
  fromUpdates: ImageState | undefined,
): ImageState {
  const restart =
    fromState === 'restart-required' ||
    fromState === 'pull-and-restart' ||
    fromUpdates === 'restart-required' ||
    fromUpdates === 'pull-and-restart';
  const pull =
    fromState === 'pull-available' ||
    fromState === 'pull-and-restart' ||
    fromUpdates === 'pull-available' ||
    fromUpdates === 'pull-and-restart';
  if (restart && pull) return 'pull-and-restart';
  if (pull) return 'pull-available';
  if (restart) return 'restart-required';
  // Neither found drift. If at least one side gave a definite 'in-sync',
  // report that; otherwise we genuinely don't know.
  if (fromState === 'in-sync' || fromUpdates === 'in-sync') return 'in-sync';
  return 'unknown';
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
          <a href="#/versions">Pull it on the Versions tab</a>
          {needsRestart ? ', then restart.' : '.'}
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
    if (!tag) return;
    const r = await confirm.ask({
      title: `Update signalk-doctor-server to ${tag}?`,
      body: 'The updater will pull the new image, restart the doctor, and roll back if it does not come up healthy. The doctor is the recovery surface, so this is the safe place to drive the update from.',
      okLabel: 'Update',
    });
    if (!r.confirmed) return;
    try {
      toast.show(`Updating signalk-doctor-server to ${tag}…`, 'info', 60000);
      await api('/api/doctor/update', { method: 'POST', body: { tag } });
      toast.show(`signalk-doctor-server updated to ${tag}`, 'ok');
      setTimeout(() => {
        void doctor.refresh();
        void state.refresh();
        void updates.refresh();
      }, 1500);
    } catch (err) {
      toast.show(
        `Doctor update failed: ${err instanceof Error ? err.message : String(err)}`,
        'err',
        8000,
      );
    }
  }, [confirm, doctor, state, updates, toast]);

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
                </>
              ) : (
                <Spinner size="sm" />
              )}
            </CardBody>
            <div className="card-footer">
              <Button
                size="sm"
                color="primary"
                disabled={!doctor.data?.updateAvailable}
                onClick={() => void doctorUpdate()}
              >
                Update
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
