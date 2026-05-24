import { mkdir, readFile, rename, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { VersionSettings } from './types.js';

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const SETTINGS_PATH = process.env.VERSION_SETTINGS_PATH ?? join(DATA_DIR, 'version-settings.json');

export const DEFAULT_VERSION_SETTINGS: VersionSettings = {
  showBeta: false,
  showMaster: false,
};

async function fsyncDir(dir: string): Promise<void> {
  const dh = await open(dir, 'r');
  try {
    await dh.sync();
  } finally {
    await dh.close();
  }
}

async function writeAtomic(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fh = await open(tmp, 'w', 0o644);
  try {
    await fh.write(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
  // Matches the Quadlet rewriter's tmp+fsync+rename+dir-fsync pattern
  // — without the directory fsync the new entry isn't durable across
  // a power loss.
  await fsyncDir(dirname(path));
}

export async function readVersionSettings(): Promise<VersionSettings> {
  try {
    const raw = await readFile(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<VersionSettings>;
    return { ...DEFAULT_VERSION_SETTINGS, ...parsed };
  } catch {
    // Missing or unparseable settings file → defaults. The operator
    // can still toggle the checkboxes; the first PUT will write it.
    return { ...DEFAULT_VERSION_SETTINGS };
  }
}

export async function writeVersionSettings(
  patch: Partial<VersionSettings>,
): Promise<VersionSettings> {
  const current = await readVersionSettings();
  const next: VersionSettings = { ...current, ...patch };
  await writeAtomic(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}
