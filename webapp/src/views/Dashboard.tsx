import { useCallback } from 'react';
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
import type { ContainerSnapshot, CurrentState, HealthResponse, SelfState } from '../types';

const STATE_COLOR: Record<ContainerSnapshot['state'], string> = {
  running: 'success',
  starting: 'warning',
  stopped: 'secondary',
  unhealthy: 'danger',
  missing: 'dark',
};

function StateBadge({ state }: { state: ContainerSnapshot['state'] }) {
  return <Badge color={STATE_COLOR[state] ?? 'secondary'}>{state}</Badge>;
}

function shortDigest(digest: string | undefined): string {
  if (!digest) return '—';
  // Strip the algo prefix ("sha256:") so the user sees just the hex.
  const hex = digest.includes(':') ? digest.slice(digest.indexOf(':') + 1) : digest;
  return hex.slice(0, 12) + '…';
}

function SnapshotRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="d-flex justify-content-between align-items-baseline mb-1">
      <span className="text-muted small">{label}</span>
      <span
        className={mono ? 'font-monospace text-truncate ms-2' : 'text-truncate ms-2'}
        style={{ maxWidth: '60%' }}
      >
        {value}
      </span>
    </div>
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

  const refreshAll = useCallback((): void => {
    void state.refresh();
    void health.refresh();
    void self.refresh();
  }, [state, health, self]);

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
      body: 'The updater will pull the new image, rewrite its own Quadlet, and restart. The browser will lose its connection for ~30s; refresh the page once it returns. signalk-server is not touched.',
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

  const doctorUrl = `${window.location.protocol}//${window.location.hostname}:3004/`;

  return (
    <>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h2 className="mb-0">Dashboard</h2>
        <Button color="secondary" outline size="sm" onClick={refreshAll}>
          Refresh
        </Button>
      </div>

      {state.error !== null ? (
        <Alert color="danger" className="mb-3">
          Failed to load state: {state.error}
        </Alert>
      ) : null}

      <Row>
        <Col xs={12} md={4} className="mb-3">
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
                  <SnapshotRow label="Image tag" value={state.data.signalkServer.tag || '—'} />
                  <SnapshotRow
                    label="Digest"
                    value={shortDigest(state.data.signalkServer.digest)}
                    mono
                  />
                  <StartedCell startedAt={state.data.signalkServer.startedAt} />
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

        <Col xs={12} md={4} className="mb-3">
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
                  <SnapshotRow label="Image tag" value={state.data.updaterServer.tag || '—'} />
                  <SnapshotRow
                    label="Digest"
                    value={shortDigest(state.data.updaterServer.digest)}
                    mono
                  />
                  <StartedCell startedAt={state.data.updaterServer.startedAt} />
                  <SnapshotRow
                    label="Update"
                    value={
                      self.data?.updateAvailable && self.data.availableTag
                        ? `Available: ${self.data.availableTag}`
                        : self.data
                          ? `Up to date (${self.data.currentTag})`
                          : '—'
                    }
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

        <Col xs={12} md={4} className="mb-3">
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
                  <SnapshotRow label="Image tag" value={state.data.doctorServer.tag || '—'} />
                  <SnapshotRow
                    label="Digest"
                    value={shortDigest(state.data.doctorServer.digest)}
                    mono
                  />
                  <StartedCell startedAt={state.data.doctorServer.startedAt} />
                </>
              ) : (
                <Spinner size="sm" />
              )}
            </CardBody>
            <div className="card-footer">
              <Button size="sm" color="secondary" outline tag="a" href={doctorUrl}>
                Open Doctor Console
              </Button>
            </div>
          </Card>
        </Col>
      </Row>

      <p className="text-muted small mt-2">
        Last check:{' '}
        {state.data ? `${fmtTime(state.data.lastCheck)} (${relTime(state.data.lastCheck)})` : '—'}
        {' · '}
        Runtime: {health.data?.runtime ?? (health.loading ? 'loading…' : 'unreachable')}
      </p>
    </>
  );
}
