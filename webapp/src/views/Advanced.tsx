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
import type { VersionSettingsResponse } from '../types';

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
      // Refresh through the hook so every consumer of the settings sees
      // the same object; the PUT response tells us it succeeded.
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
    </div>
  );
}
