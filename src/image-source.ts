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

/** Provenance remembered per REF (bounded), so a rollback to a ref that was
 *  originally switched to from an archive keeps its archive provenance
 *  instead of silently becoming 'registry'. Stored under a reserved key
 *  in the same file. */
type HistoryEntry = Pick<ImageSourceRecord, 'source' | 'archive' | 'archiveMtimeMs'>;
const HISTORY_KEY = '__history';
const HISTORY_MAX = 20;

const filePath = (): string =>
  process.env.IMAGE_SOURCE_PATH ?? join(process.env.DATA_DIR ?? '/data', 'image-source.json');

function sanitizeRecord(v: unknown): ImageSourceRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.ref !== 'string' || (r.source !== 'registry' && r.source !== 'archive')) return null;
  const rec: ImageSourceRecord = {
    ref: r.ref,
    source: r.source,
    at: typeof r.at === 'string' ? r.at : '',
  };
  if (r.source === 'archive') {
    if (typeof r.archive !== 'string') return null;
    rec.archive = r.archive;
    if (typeof r.archiveMtimeMs === 'number' && Number.isFinite(r.archiveMtimeMs)) {
      rec.archiveMtimeMs = r.archiveMtimeMs;
    }
  }
  return rec;
}

interface Parsed {
  records: ImageSourceFile;
  history: Record<string, HistoryEntry>;
}

async function readParsed(): Promise<Parsed> {
  const out: Parsed = { records: {}, history: {} };
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath(), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return out;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (k === HISTORY_KEY) {
        if (typeof v === 'object' && v !== null) {
          for (const [ref, h] of Object.entries(v as Record<string, unknown>)) {
            // Reuse the record validator: history entries are records minus ref/at.
            const rec = sanitizeRecord({ ...(h as object), ref, at: '' });
            if (rec) {
              out.history[ref] = {
                source: rec.source,
                ...(rec.archive !== undefined ? { archive: rec.archive } : {}),
                ...(rec.archiveMtimeMs !== undefined ? { archiveMtimeMs: rec.archiveMtimeMs } : {}),
              };
            }
          }
        }
        continue;
      }
      const rec = sanitizeRecord(v);
      if (rec) out.records[k] = rec;
    }
  } catch {
    // missing / corrupt → empty
  }
  return out;
}

async function readAll(): Promise<ImageSourceFile> {
  return (await readParsed()).records;
}

async function writeParsed(p: Parsed): Promise<void> {
  // Trim history to the most recent entries (insertion order).
  const refs = Object.keys(p.history);
  const trimmed: Record<string, HistoryEntry> = {};
  for (const ref of refs.slice(Math.max(0, refs.length - HISTORY_MAX))) {
    const h = p.history[ref];
    if (h) trimmed[ref] = h;
  }
  await writeAtomicJson(filePath(), { ...p.records, [HISTORY_KEY]: trimmed });
}

/** Record where `quadletName`'s new image came from. Best-effort: a write
 *  failure must never fail an otherwise-good switch (caller catches). */
export async function recordImageSource(
  quadletName: string,
  rec: Omit<ImageSourceRecord, 'at'>,
): Promise<void> {
  const p = await readParsed();
  p.records[quadletName] = { ...rec, at: new Date().toISOString() };
  // Re-insert so the ref becomes the most recent history entry.
  delete p.history[rec.ref];
  p.history[rec.ref] = {
    source: rec.source,
    ...(rec.archive !== undefined ? { archive: rec.archive } : {}),
    ...(rec.archiveMtimeMs !== undefined ? { archiveMtimeMs: rec.archiveMtimeMs } : {}),
  };
  await writeParsed(p);
}

/**
 * Record provenance for a ref whose origin the caller doesn't know (a
 * rollback re-applies a last-good ref): reuse what we remembered for that
 * ref, else 'registry'.
 */
export async function recordImageSourceForRef(quadletName: string, ref: string): Promise<void> {
  const p = await readParsed();
  const h = p.history[ref];
  const rec: Omit<ImageSourceRecord, 'at'> =
    h && h.source === 'archive' && h.archive
      ? {
          ref,
          source: 'archive',
          archive: h.archive,
          ...(h.archiveMtimeMs !== undefined ? { archiveMtimeMs: h.archiveMtimeMs } : {}),
        }
      : { ref, source: 'registry' };
  await recordImageSource(quadletName, rec);
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
