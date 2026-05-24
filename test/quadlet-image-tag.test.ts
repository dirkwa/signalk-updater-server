import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readQuadletImageTag } from '../src/quadlet-image-tag.js';

let dir: string;
const originalQuadletDir = process.env.QUADLET_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quadlet-image-tag-test-'));
  process.env.QUADLET_DIR = dir;
});

afterEach(async () => {
  if (originalQuadletDir === undefined) delete process.env.QUADLET_DIR;
  else process.env.QUADLET_DIR = originalQuadletDir;
  await rm(dir, { recursive: true, force: true });
});

describe('readQuadletImageTag', () => {
  it('returns the tag suffix from Image= for a pinned semver', async () => {
    await writeFile(
      join(dir, 'foo.container'),
      `[Container]\nImage=ghcr.io/dirkwa/signalk-server:0.6.2\n`,
    );
    expect(await readQuadletImageTag('foo.container')).toBe('0.6.2');
  });

  it('returns "latest" when the Quadlet pins :latest', async () => {
    await writeFile(
      join(dir, 'foo.container'),
      `[Container]\nImage=ghcr.io/dirkwa/signalk-server:latest\n`,
    );
    expect(await readQuadletImageTag('foo.container')).toBe('latest');
  });

  it('strips an optional @sha256:... digest pin before extracting the tag', async () => {
    await writeFile(
      join(dir, 'foo.container'),
      `[Container]\nImage=ghcr.io/dirkwa/signalk-server:0.6.1@sha256:abcdef0123456789\n`,
    );
    expect(await readQuadletImageTag('foo.container')).toBe('0.6.1');
  });

  it('returns "unknown" when the tag suffix is a sha256 digest (40+ hex)', async () => {
    await writeFile(
      join(dir, 'foo.container'),
      `[Container]\nImage=ghcr.io/dirkwa/signalk-server:6917c626fd1968fa3a43b55834deca79d14afeda97b8b1c75bad03da5cffde82\n`,
    );
    expect(await readQuadletImageTag('foo.container')).toBe('unknown');
  });

  it('returns "unknown" when the Image= line lacks a tag', async () => {
    await writeFile(
      join(dir, 'foo.container'),
      `[Container]\nImage=ghcr.io/dirkwa/signalk-server\n`,
    );
    expect(await readQuadletImageTag('foo.container')).toBe('unknown');
  });

  it('returns "unknown" when the file is missing', async () => {
    expect(await readQuadletImageTag('does-not-exist.container')).toBe('unknown');
  });

  it('returns "unknown" when the file has no Image= line at all', async () => {
    await writeFile(
      join(dir, 'foo.container'),
      `[Unit]\nDescription=No image here\n[Container]\nContainerName=foo\n`,
    );
    expect(await readQuadletImageTag('foo.container')).toBe('unknown');
  });

  it('matches only the first Image= line (the Quadlet only ever has one)', async () => {
    await writeFile(
      join(dir, 'foo.container'),
      `[Container]\nImage=ghcr.io/dirkwa/signalk-server:0.6.2\n# Image=ghcr.io/dirkwa/signalk-server:0.5.0\n`,
    );
    expect(await readQuadletImageTag('foo.container')).toBe('0.6.2');
  });
});
