import { useCallback } from 'react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Spinner, Table } from 'reactstrap';
import { api } from '../api';
import { useApi } from '../hooks/useApi';
import { useToast } from '../toast';
import { useConfirm } from '../confirm';
import { fmtTime, relTime } from '../time';
import type { Channel, CurrentState, SwitchResult, Tag, VersionsResponse } from '../types';

const CHANNEL_ORDER: Channel[] = ['stable', 'beta', 'master', 'dirkwa'];

const CHANNEL_DESCRIPTIONS: Record<Channel, string> = {
  stable: 'Production releases — long-tested, recommended for boats in use.',
  beta: 'Pre-release builds — newer features, may have rough edges.',
  master: 'Bleeding edge from the master branch — every commit on signalk-server/main.',
  dirkwa: 'Custom builds maintained in dirkwa/signalk-server.',
};

// Cap per-channel rendering so the master channel (potentially
// hundreds of commits) doesn't drown the UI on first paint.
const MAX_VISIBLE_PER_CHANNEL = 25;

function shortDigest(digest: string): string {
  const hex = digest.includes(':') ? digest.slice(digest.indexOf(':') + 1) : digest;
  return hex.slice(0, 12);
}

export function Versions() {
  const toast = useToast();
  const confirm = useConfirm();

  // Cached fetch — fast; the POST /check below forces a fresh GHCR pull.
  const versions = useApi<VersionsResponse>((signal) => api('/api/versions', { signal }));
  // We only need the current signalk-server tag for the "in use" badge;
  // poll lightly so a freshly-switched tag flips its badge within ~5s.
  const state = useApi<CurrentState>((signal) => api('/api/state', { signal }), {
    intervalMs: 5000,
  });

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

  const doSwitch = useCallback(
    async (tag: string): Promise<void> => {
      const r = await confirm.ask({
        title: `Switch to ${tag}?`,
        body: 'signalk-server will be stopped, the new image pulled, and the container restarted on the new tag. A pre-switch backup runs if signalk-backup is installed. Estimated downtime: 30–90s.',
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
        // Bounce the state poll so the "in use" badge flips to the new tag.
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

      {versions.error !== null ? (
        <Alert color="danger">Failed to fetch tags: {versions.error}</Alert>
      ) : null}

      {versions.loading && !versions.data ? <Spinner /> : null}

      {versions.data
        ? CHANNEL_ORDER.map((channel) => {
            const tags = versions.data?.channels[channel] ?? [];
            if (tags.length === 0) return null;
            return (
              <ChannelCard
                key={channel}
                channel={channel}
                tags={tags}
                currentTag={currentTag}
                onSwitch={doSwitch}
              />
            );
          })
        : null}
    </>
  );
}

function countTags(v: VersionsResponse): number {
  return CHANNEL_ORDER.reduce((n, c) => n + (v.channels[c]?.length ?? 0), 0);
}

interface ChannelCardProps {
  channel: Channel;
  tags: Tag[];
  currentTag: string | null;
  onSwitch: (tag: string) => void;
}

function ChannelCard({ channel, tags, currentTag, onSwitch }: ChannelCardProps) {
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
              <th className="text-end" style={{ width: '8rem' }}>
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((t) => {
              const isCurrent = t.name === currentTag;
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
                  <td className="text-end">
                    <Button
                      size="sm"
                      color="primary"
                      outline
                      disabled={isCurrent}
                      onClick={() => onSwitch(t.name)}
                    >
                      {isCurrent ? 'In use' : 'Switch'}
                    </Button>
                  </td>
                </tr>
              );
            })}
            {overflow > 0 ? (
              <tr>
                <td colSpan={4} className="text-muted small text-center">
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
