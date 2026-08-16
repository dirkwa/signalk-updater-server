import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomicJson } from './atomic-file.js';
import { readQuadletImageRef } from './quadlet-image-tag.js';
import type { ImageSourceKind } from './types.js';

/**
 * Provenance of the image a Quadlet currently points at: did the last
 * switch take it from a registry or from a local image file? Drives the
 * source-aware "update available" signal in update-checker.ts — an
 * archive-sourced install must be told about a NEWER FILE in the folder,
 * and must NOT be nagged about GHCR (which it may not even reach).
 *
 * Stored in the updater's own `/data/image-source.json` (not in
 * last-good.json, which lives under /doctor-data and is a cross-repo
 * shape the doctor reads). Written by the switch flow after a successful
 * switch; resolved against the Quadlet's live `Image=` so a hand-edited
 * Quadlet or a pre-feature install falls back to `'registry'`.
 */

export interface ImageSourceRecord {
  /** Full `repo:tag` the Quadlet was rewritten to. */
  ref: string;
  source: ImageSourceKind;
  /** Archive file name (source: 'archive'). */
  archive?: string;
  /** Archive mtime at switch time (source: 'archive'); the "newer file"
   *  comparison key. */
  archiveMtimeMs?: number;
  at: string;
}

type ImageSourceFile = Record<string, ImageSourceRecord>;

const filePath = (): string =>
  process.env.IMAGE_SOURCE_PATH ?? join(process.env.DATA_DIR ?? '/data', 'image-source.json');

async function readAll(): Promise<ImageSourceFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath(), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as ImageSourceFile) : {};
  } catch {
    return {};
  }
}

/** Record where `quadletName`'s new image came from. Best-effort: a write
 *  failure must never fail an otherwise-good switch (caller catches). */
export async function recordImageSource(
  quadletName: string,
  rec: Omit<ImageSourceRecord, 'at'>,
): Promise<void> {
  const all = await readAll();
  all[quadletName] = { ...rec, at: new Date().toISOString() };
  await writeAtomicJson(filePath(), all);
}

export interface ResolvedImageSource {
  source: ImageSourceKind;
  /** Present only for source 'archive'. */
  archive?: string;
  archiveMtimeMs?: number;
}

/**
 * The provenance that applies to the Quadlet's CURRENT `Image=`. Only the
 * recorded entry whose `ref` equals the live ref counts; anything else
 * (Quadlet edited by hand, rollback to an older ref, no record) is
 * `'registry'` — the pre-feature behaviour.
 */
export async function resolveImageSource(quadletName: string): Promise<ResolvedImageSource> {
  const [all, live] = await Promise.all([readAll(), readQuadletImageRef(quadletName)]);
  const rec = all[quadletName];
  if (!rec || live === null || rec.ref !== live) return { source: 'registry' };
  if (rec.source === 'archive' && rec.archive) {
    return {
      source: 'archive',
      archive: rec.archive,
      ...(typeof rec.archiveMtimeMs === 'number' ? { archiveMtimeMs: rec.archiveMtimeMs } : {}),
    };
  }
  return { source: 'registry' };
}
