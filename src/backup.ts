import { resolveRuntime } from './podman/client.js';
import { resolveSignalkBaseUrl } from './signalk-url-resolver.js';

const BACKUP_SERVER = 'signalk-backup-server';
const BACKUP_SERVER_URL = process.env.BACKUP_SERVER_URL ?? 'http://127.0.0.1:3010';
const BACKUP_PLUGIN_PATH = '/plugins/signalk-backup/api/snapshot';

export type BackupResult =
  | { taken: true; via: 'backup-server' | 'plugin'; durationMs: number }
  | { taken: false; reason: 'skipped' | 'no-backup-installed' | 'failed'; error?: string };

async function detectBackupServer(): Promise<boolean> {
  const rt = await resolveRuntime();
  if (!rt) return false;
  try {
    const c = rt.client.getContainer(BACKUP_SERVER);
    const info = (await c.inspect()) as unknown as { State?: { Running?: boolean } };
    return Boolean(info.State?.Running);
  } catch {
    return false;
  }
}

async function postSnapshot(url: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${url}/api/snapshot`, { method: 'POST' });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function postPluginSnapshot(): Promise<{ ok: boolean; error?: string }> {
  try {
    const baseUrl = await resolveSignalkBaseUrl();
    const res = await fetch(`${baseUrl}${BACKUP_PLUGIN_PATH}`, { method: 'POST' });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function preSwitchBackup(skip: boolean): Promise<BackupResult> {
  if (skip) return { taken: false, reason: 'skipped' };
  const start = Date.now();

  if (await detectBackupServer()) {
    const r = await postSnapshot(BACKUP_SERVER_URL);
    if (r.ok) return { taken: true, via: 'backup-server', durationMs: Date.now() - start };
    // fall through to plugin attempt
  }

  const p = await postPluginSnapshot();
  if (p.ok) return { taken: true, via: 'plugin', durationMs: Date.now() - start };

  // Neither path worked — distinguish "not installed" from "failed".
  // Heuristic: if backup-server is missing AND plugin returned 404, it's not installed.
  if (p.error?.includes('404')) return { taken: false, reason: 'no-backup-installed' };
  return { taken: false, reason: 'failed', error: p.error };
}
