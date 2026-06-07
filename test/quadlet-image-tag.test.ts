import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readQuadletImageRef, readQuadletImageTag } from '../src/quadlet-image-tag.js';

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

describe('readQuadletImageRef', () => {
  it('returns the full registry/repo:tag ref for a floating tag', async () => {
    await writeFile(
      join(dir, 'foo.container'),
      `[Container]\nImage=ghcr.io/dirkwa/signalk-server:dirkwa\n`,
    );
    expect(await readQuadletImageRef('foo.container')).toBe('ghcr.io/dirkwa/signalk-server:dirkwa');
  });

  it('returns the full ref for a pinned semver', async () => {
    await writeFile(
      join(dir, 'foo.container'),
      `[Container]\nImage=ghcr.io/dirkwa/signalk-server:0.6.2\n`,
    );
    expect(await readQuadletImageRef('foo.container')).toBe('ghcr.io/dirkwa/signalk-server:0.6.2');
  });

  it('strips an @sha256 digest pin but keeps the tagged ref', async () => {
    await writeFile(
      join(dir, 'foo.container'),
      `[Container]\nImage=ghcr.io/dirkwa/signalk-server:dirkwa@sha256:abcdef0123456789\n`,
    );
    expect(await readQuadletImageRef('foo.container')).toBe('ghcr.io/dirkwa/signalk-server:dirkwa');
  });

  it('returns null for a bare repo with no tag', async () => {
    await writeFile(
      join(dir, 'foo.container'),
      `[Container]\nImage=ghcr.io/dirkwa/signalk-server\n`,
    );
    expect(await readQuadletImageRef('foo.container')).toBeNull();
  });

  it('returns null when only a digest is pinned (no tag)', async () => {
    await writeFile(
      join(dir, 'foo.container'),
      `[Container]\nImage=ghcr.io/dirkwa/signalk-server@sha256:abcdef0123456789\n`,
    );
    expect(await readQuadletImageRef('foo.container')).toBeNull();
  });

  it('does not mistake a registry-port colon for a tag', async () => {
    // `ghcr.io:443/dirkwa/signalk-server` — the colon precedes the last
    // slash, so there is no tag. Must be null, not "443/dirkwa/...".
    await writeFile(
      join(dir, 'foo.container'),
      `[Container]\nImage=ghcr.io:443/dirkwa/signalk-server\n`,
    );
    expect(await readQuadletImageRef('foo.container')).toBeNull();
  });

  it('keeps the registry port AND the tag when both are present', async () => {
    await writeFile(
      join(dir, 'foo.container'),
      `[Container]\nImage=ghcr.io:443/dirkwa/signalk-server:dirkwa\n`,
    );
    expect(await readQuadletImageRef('foo.container')).toBe(
      'ghcr.io:443/dirkwa/signalk-server:dirkwa',
    );
  });

  it('returns null when the file is missing', async () => {
    expect(await readQuadletImageRef('does-not-exist.container')).toBeNull();
  });

  it('returns null when there is no Image= line', async () => {
    await writeFile(join(dir, 'foo.container'), `[Container]\nContainerName=foo\n`);
    expect(await readQuadletImageRef('foo.container')).toBeNull();
  });
});
