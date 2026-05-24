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
import { api } from '../api';
import { useApi } from '../hooks/useApi';
import { useToast } from '../toast';
import { useConfirm } from '../confirm';
import { fmtTime, relTime } from '../time';
import type {
  AnnotatedTag,
  Channel,
  CurrentState,
  SwitchProgressEvent,
  SwitchResult,
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

function isChannelVisible(channel: Channel, settings: VersionSettings | null): boolean {
  if (channel === 'stable' || channel === 'dirkwa') return true;
  if (channel === 'beta') return settings?.showBeta ?? false;
  if (channel === 'master') return settings?.showMaster ?? false;
  return true;
}

export function Versions() {
  const toast = useToast();
  const confirm = useConfirm();

  const versions = useApi<VersionsResponse>((signal) => api('/api/versions', { signal }));
  const state = useApi<CurrentState>((signal) => api('/api/state', { signal }), {
    intervalMs: 5000,
  });
  const settings = useApi<VersionSettings>((signal) => api('/api/versions/settings', { signal }));

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

  // Open one persistent SSE channel so the progress card reflects any
  // in-flight switch, even one another browser kicked off. The broker
  // emits its lastEvent immediately on connect, so reloading the tab
  // mid-flow picks the state right back up.
  useEffect(() => {
    const es = new EventSource('/api/versions/switch/stream');
    eventSourceRef.current = es;
    es.onmessage = (ev: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(ev.data) as SwitchProgressEvent;
        setProgress(parsed);
        if (parsed.stage === 'complete' || parsed.stage === 'failed') {
          // Refresh the version list + state so the "in use" badge and
          // isLocal flags catch up.
          void versionsRef.current.refresh();
          void stateRef.current.refresh();
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
      try {
        await api('/api/versions/pull', { method: 'POST', body: { tag } });
        await versions.refresh();
        toast.show(`Pulled ${tag}`, 'ok');
      } catch (err) {
        toast.show(`Pull failed: ${err instanceof Error ? err.message : String(err)}`, 'err', 8000);
      } finally {
        setPullingTag(null);
      }
    },
    [toast, versions],
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
        toast.show(`Switching to ${tag}…`, 'info', 30000);
        const result = await api<SwitchResult>('/api/versions/switch', {
          method: 'POST',
          body: { tag, skipBackup: r.skipBackup },
        });
        if (result.rolledBack === true) {
          toast.show(
            `Switch failed; rolled back to ${result.from}. ${result.error ?? ''}`.trim(),
            'err',
            8000,
          );
        } else if (result.ok) {
          const secs = Math.round(result.durationMs / 100) / 10;
          toast.show(`Switched to ${result.to} in ${secs}s`, 'ok');
        } else {
          toast.show(`Switch returned: ${result.error ?? 'unknown failure'}`, 'err');
        }
        setTimeout(() => void state.refresh(), 1500);
      } catch (err) {
        toast.show(
          `Switch failed: ${err instanceof Error ? err.message : String(err)}`,
          'err',
          8000,
        );
      }
    },
    [confirm, state, toast],
  );

  const currentTag = state.data?.signalkServer.tag ?? null;
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
        <Alert color="danger">Failed to fetch tags: {versions.error}</Alert>
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
  pullingTag: string | null;
  switchInFlight: boolean;
  onPull: (tag: string) => void;
  onSwitch: (tag: string) => void;
}

function ChannelCard({
  channel,
  tags,
  currentTag,
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
              <th className="d-none d-md-table-cell">Pushed</th>
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
                  </td>
                  <td className="d-none d-md-table-cell text-muted small">
                    {relTime(t.pushedAt) || '—'}
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
                      <span className="text-muted small">In use</span>
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
