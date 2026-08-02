import { describe, expect, it } from 'vitest';
import { changelogLinkFor, dirkwaDetails, shortSha } from './changelog-links';
import type { Tag, TagLabels } from './types';

const UPSTREAM = 'https://github.com/SignalK/signalk-server';
const IMAGES = 'https://github.com/dirkwa/signalk-server-images';

function tag(name: string, channel: Tag['channel'], labels?: TagLabels): Tag {
  return { name, channel, digest: 'sha256:abc', pushedAt: null, ...(labels ? { labels } : {}) };
}

describe('changelogLinkFor', () => {
  it('maps a pinned stable tag to the upstream release page', () => {
    expect(changelogLinkFor(tag('v2.30.0', 'stable'))?.href).toBe(
      `${UPSTREAM}/releases/tag/v2.30.0`,
    );
  });

  it('maps an unprefixed semver tag to the v-prefixed release page', () => {
    expect(changelogLinkFor(tag('2.30.0', 'stable'))?.href).toBe(
      `${UPSTREAM}/releases/tag/v2.30.0`,
    );
  });

  it('resolves bare latest through the version label', () => {
    expect(changelogLinkFor(tag('latest', 'stable', { version: '2.30.0' }))?.href).toBe(
      `${UPSTREAM}/releases/tag/v2.30.0`,
    );
  });

  it('falls back to the revision commit for latest without a version label', () => {
    expect(changelogLinkFor(tag('latest', 'stable', { revision: 'a'.repeat(40) }))?.href).toBe(
      `${UPSTREAM}/commit/${'a'.repeat(40)}`,
    );
  });

  it('returns null for latest with no usable labels', () => {
    expect(changelogLinkFor(tag('latest', 'stable'))).toBeNull();
  });

  it('maps a beta tag to its prerelease page', () => {
    expect(changelogLinkFor(tag('v2.28.0-beta.2', 'beta'))?.href).toBe(
      `${UPSTREAM}/releases/tag/v2.28.0-beta.2`,
    );
  });

  it('prefers the revision label for master builds', () => {
    const sha = 'b'.repeat(40);
    expect(changelogLinkFor(tag('master-b1b1b1b', 'master', { revision: sha }))?.href).toBe(
      `${UPSTREAM}/commit/${sha}`,
    );
  });

  it('falls back to the sha embedded in the master tag name', () => {
    expect(changelogLinkFor(tag('master-abc1234', 'master'))?.href).toBe(
      `${UPSTREAM}/commit/abc1234`,
    );
  });

  it('maps bare master to the branch commit history', () => {
    expect(changelogLinkFor(tag('master', 'master'))?.href).toBe(`${UPSTREAM}/commits/master`);
  });

  it('links a labeled dirkwa build to its upstream base commit', () => {
    const sha = 'c'.repeat(40);
    expect(
      changelogLinkFor(tag('dirkwa-dfb1444', 'dirkwa', { baseSha: sha, revision: 'd'.repeat(40) }))
        ?.href,
    ).toBe(`${UPSTREAM}/commit/${sha}`);
  });

  it('never links the dirkwa revision label (unresolvable merge commit)', () => {
    const link = changelogLinkFor(tag('dirkwa-dfb1444', 'dirkwa', { revision: 'd'.repeat(40) }));
    // No baseSha → falls back to the images-repo state history, not the
    // revision commit, which exists in no public repo.
    expect(link?.href).toBe(`${IMAGES}/commits/main/state/last-dirkwa.txt`);
  });

  it('links label-less dirkwa tags to the state-file history', () => {
    expect(changelogLinkFor(tag('dirkwa', 'dirkwa'))?.href).toBe(
      `${IMAGES}/commits/main/state/last-dirkwa.txt`,
    );
  });

  it('returns null for unrecognized tags bucketed into the dirkwa channel', () => {
    expect(changelogLinkFor(tag('some-random-tag', 'dirkwa'))).toBeNull();
  });

  it('drops malformed label values instead of building hrefs from them', () => {
    expect(changelogLinkFor(tag('latest', 'stable', { version: 'not-a-version' }))).toBeNull();
    expect(changelogLinkFor(tag('master', 'master', { revision: '../../evil' }))?.href).toBe(
      `${UPSTREAM}/commits/master`,
    );
  });
});

describe('dirkwaDetails', () => {
  const base = 'e'.repeat(40);

  it('returns base + PR links for a fully labeled build', () => {
    const d = dirkwaDetails(
      tag('dirkwa-dfb1444', 'dirkwa', { baseSha: base, prs: '2588:7cf1e3b 2524:ef613fa' }),
    );
    expect(d?.base?.href).toBe(`${UPSTREAM}/commit/${base}`);
    expect(d?.prs.map((p) => p.href)).toEqual([`${UPSTREAM}/pull/2588`, `${UPSTREAM}/pull/2524`]);
    expect(d?.prs.map((p) => p.number)).toEqual(['2588', '2524']);
  });

  it('tolerates bare PR numbers without sha suffixes', () => {
    const d = dirkwaDetails(tag('dirkwa', 'dirkwa', { prs: '2588 2524' }));
    expect(d?.prs).toHaveLength(2);
    expect(d?.base).toBeNull();
  });

  it('skips malformed PR entries', () => {
    const d = dirkwaDetails(tag('dirkwa', 'dirkwa', { prs: '2588:7cf1e3b bogus/entry' }));
    expect(d?.prs.map((p) => p.number)).toEqual(['2588']);
  });

  it('returns null without dirkwa stack labels', () => {
    expect(dirkwaDetails(tag('dirkwa-old', 'dirkwa'))).toBeNull();
    expect(dirkwaDetails(tag('dirkwa-old', 'dirkwa', { revision: 'f'.repeat(40) }))).toBeNull();
  });

  it('returns null for non-dirkwa channels', () => {
    expect(dirkwaDetails(tag('v2.30.0', 'stable', { prs: '2588' }))).toBeNull();
  });
});

describe('shortSha', () => {
  it('truncates to 7 chars', () => {
    expect(shortSha('abcdef0123456789')).toBe('abcdef0');
  });
});
