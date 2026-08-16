import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  Form,
  FormGroup,
  FormText,
  Input,
  Label,
  Spinner,
} from 'reactstrap';
import { api } from '../api';
import { useApi } from '../hooks/useApi';
import { useToast } from '../toast';
import type { ArchivesResponse, VersionSettingsResponse } from '../types';

/**
 * Advanced tab. Currently one setting: the GHCR repository the Versions
 * tab lists and Pull/Switch install signalk-server from. Lets an operator
 * run signalk-server from their own fork of signalk-server-images.
 *
 * The server validates and canonicalises the value (GHCR-only, no tag,
 * no digest) and returns the effective repo + its source, so this view
 * never has to know the engine's env or defaults.
 */
export function Advanced() {
  const toast = useToast();
  const settings = useApi<VersionSettingsResponse>((signal) =>
    api('/api/versions/settings', { signal }),
  );
  const archives = useApi<ArchivesResponse>((signal) => api('/api/versions/archives', { signal }));
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Seed the input from the stored override once it's loaded (and again
  // after each save, since the server echoes the canonical form back).
  const stored = settings.data?.imageRepo ?? '';
  useEffect(() => {
    setDraft(stored);
    setFieldError(null);
  }, [stored]);

  const applyResponse = useCallback(
    async (next: VersionSettingsResponse, message: string): Promise<void> => {
      // Re-read through the hook so this view's `settings.data` is the
      // server-canonical value (the input is seeded from it); the PUT
      // response is used for the toast.
      await settings.refresh();
      setFieldError(null);
      toast.show(
        `${message} Now using ${next.effectiveImageRepo}. Open Versions to see its tags.`,
        'ok',
        6000,
      );
    },
    [settings, toast],
  );

  const save = useCallback(
    async (value: string | null): Promise<void> => {
      setSaving(true);
      try {
        const next = await api<VersionSettingsResponse>('/api/versions/settings', {
          method: 'PUT',
          body: { imageRepo: value },
        });
        await applyResponse(
          next,
          value === null ? 'Image repository reset to default.' : 'Image repository saved.',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setFieldError(msg);
        toast.show(`Could not save image repository: ${msg}`, 'err', 6000);
      } finally {
        setSaving(false);
      }
    },
    [applyResponse, toast],
  );

  const data = settings.data;
  const trimmed = draft.trim();
  const unchanged = trimmed === stored;
  const canSave = !saving && trimmed !== '' && !unchanged;

  return (
    <div>
      <Card className="mb-3">
        <CardHeader>
          <strong>signalk-server image repository</strong>
        </CardHeader>
        <CardBody>
          <p className="text-muted mb-3">
            Which GHCR repository the Versions tab lists and Pull / Switch install signalk-server
            from. Point this at your own fork of signalk-server-images to run your own builds. Only{' '}
            <code>ghcr.io/…</code> repositories are supported. Changing it does not touch the
            running container — the next Switch writes the new repository into the Quadlet.
          </p>

          {settings.error !== null && !data ? (
            <Alert color="warning" className="mb-3">
              Could not load settings ({settings.error}).
            </Alert>
          ) : null}
          {settings.loading && !data ? <Spinner size="sm" /> : null}

          {data ? (
            <Form
              onSubmit={(e) => {
                e.preventDefault();
                if (canSave) void save(trimmed);
              }}
            >
              <FormGroup>
                <Label for="imageRepo">Repository</Label>
                <Input
                  id="imageRepo"
                  type="text"
                  className="font-monospace"
                  placeholder={data.defaultImageRepo}
                  value={draft}
                  invalid={fieldError !== null}
                  disabled={saving}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setFieldError(null);
                  }}
                />
                {fieldError !== null ? (
                  <FormText color="danger" className="d-block">
                    {fieldError}
                  </FormText>
                ) : null}
                <FormText>
                  e.g. <code>ghcr.io/&lt;owner&gt;/signalk-server</code> — no tag, no digest.
                </FormText>
              </FormGroup>
              <div className="d-flex align-items-center gap-2 flex-wrap">
                <Button type="submit" color="primary" size="sm" disabled={!canSave}>
                  {saving ? <Spinner size="sm" className="me-1" /> : null}
                  Save
                </Button>
                {data.imageRepoSource === 'setting' ? (
                  <Button
                    type="button"
                    color="secondary"
                    outline
                    size="sm"
                    disabled={saving}
                    onClick={() => void save(null)}
                  >
                    Reset to default
                  </Button>
                ) : null}
                <span className="text-muted small ms-auto">
                  Currently using <code>{data.effectiveImageRepo}</code>{' '}
                  {data.imageRepoSource === 'setting' ? '(custom setting)' : '(default)'}
                </span>
              </div>
            </Form>
          ) : null}
        </CardBody>
      </Card>

      <Card className="mb-3">
        <CardHeader>
          <strong>Local image files</strong>
        </CardHeader>
        <CardBody>
          <p className="text-muted mb-2">
            For boats without internet: put <code>podman save</code> archives into{' '}
            <code>~/.signalk-updater/images</code> on the host
            {archives.data ? (
              <>
                {' '}
                (<code>{archives.data.dir}</code> inside the engine)
              </>
            ) : null}
            . The Versions tab lists them under <strong>Local image files</strong>; Load imports the
            file into the local image store, Switch then restarts signalk-server on it without
            contacting any registry.
          </p>
          <p className="text-muted mb-2">
            Create an archive on a machine that has internet, then copy it over (scp, SFTP, a file
            manager, USB stick):
          </p>
          <pre className="small mb-2">
            <code>
              {[
                'podman pull ghcr.io/dirkwa/signalk-server:<tag>',
                'podman save ghcr.io/dirkwa/signalk-server:<tag> -o signalk-server-<tag>.tar',
                '# or compressed:',
                'podman save ghcr.io/dirkwa/signalk-server:<tag> | gzip > signalk-server-<tag>.tar.gz',
              ].join('\n')}
            </code>
          </pre>
          <p className="text-muted small mb-0">
            <code>.tar</code>, <code>.tar.gz</code> and <code>.tgz</code> are recognised (docker- or
            OCI-archive). Once signalk-server runs from a local file, &ldquo;update available&rdquo;
            means a newer file appeared in this folder — the registry is not consulted.{' '}
            {archives.data
              ? `${archives.data.archives.length} file${archives.data.archives.length === 1 ? '' : 's'} present.`
              : null}{' '}
            <a href="#/versions">Open Versions</a>.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
