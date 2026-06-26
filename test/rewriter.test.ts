import { describe, it, expect } from 'vitest';
import { rewriteImageLine, toggleBootStart } from '../src/quadlet/rewriter.js';

const SAMPLE_QUADLET = `[Unit]
Description=SignalK Server
Wants=network-online.target

[Container]
Image=ghcr.io/dirkwa/signalk-server:v1.2.3
ContainerName=signalk-server
PublishPort=127.0.0.1:3000:3000

Volume=%h/.signalk:/home/node/.signalk:Z
Volume=%t/podman/podman.sock:/var/run/docker.sock

[Service]
Restart=on-failure
RestartSec=10
`;

// Canonical engine Quadlet shape (CC-4: Restart=on-failure + start-limit guard;
// Restart=always is banned).
const QUADLET_WITH_INSTALL = `[Container]
Image=ghcr.io/dirkwa/signalk-server:dirkwa
ContainerName=signalk-server

[Service]
Restart=on-failure
StartLimitIntervalSec=300
StartLimitBurst=5

[Install]
WantedBy=default.target
`;

describe('rewriteImageLine', () => {
  it('replaces Image= with new tag', () => {
    const { body, previous } = rewriteImageLine(
      SAMPLE_QUADLET,
      'ghcr.io/dirkwa/signalk-server:v2.0.0',
    );
    expect(previous).toBe('ghcr.io/dirkwa/signalk-server:v1.2.3');
    expect(body).toContain('Image=ghcr.io/dirkwa/signalk-server:v2.0.0');
    expect(body).not.toContain('Image=ghcr.io/dirkwa/signalk-server:v1.2.3');
  });

  it('preserves indentation', () => {
    const indented = `[Container]\n  Image=foo:1\n`;
    const { body } = rewriteImageLine(indented, 'foo:2');
    expect(body).toContain('  Image=foo:2');
  });

  it('throws if no Image= line', () => {
    expect(() => rewriteImageLine('[Container]\nName=foo', 'foo:2')).toThrow();
  });

  it('only replaces the first Image= occurrence', () => {
    const dual = `[Container]\nImage=a:1\nDescription=text mentioning Image=b:2 in prose\n`;
    const { body, previous } = rewriteImageLine(dual, 'a:2');
    expect(previous).toBe('a:1');
    expect(body).toContain('Image=a:2');
    expect(body).toContain('Image=b:2'); // prose untouched
  });
});

describe('toggleBootStart', () => {
  it('disabling comments out the WantedBy= line with the marker', () => {
    const { body, changed } = toggleBootStart(QUADLET_WITH_INSTALL, false);
    expect(changed).toBe(true);
    expect(body).toContain('#SK-PAUSED# WantedBy=default.target');
    // The active (un-marked) directive must be gone so the generator drops
    // the default.target wants symlink.
    expect(body).not.toMatch(/^WantedBy=default\.target$/m);
  });

  it('round-trips back to the exact original on re-enable', () => {
    const paused = toggleBootStart(QUADLET_WITH_INSTALL, false).body;
    const { body, changed } = toggleBootStart(paused, true);
    expect(changed).toBe(true);
    expect(body).toBe(QUADLET_WITH_INSTALL);
  });

  it('is a no-op (changed=false) when already in the requested state', () => {
    // already enabled -> enabling does nothing
    expect(toggleBootStart(QUADLET_WITH_INSTALL, true).changed).toBe(false);
    // already paused -> pausing again does nothing, and never double-marks
    const paused = toggleBootStart(QUADLET_WITH_INSTALL, false).body;
    const again = toggleBootStart(paused, false);
    expect(again.changed).toBe(false);
    expect(again.body).toBe(paused);
    expect(again.body).not.toContain('#SK-PAUSED# #SK-PAUSED#');
  });

  it('preserves indentation around the toggled line', () => {
    const indented = `[Install]\n  WantedBy=default.target\n`;
    const paused = toggleBootStart(indented, false).body;
    expect(paused).toBe('[Install]\n  #SK-PAUSED# WantedBy=default.target\n');
    expect(toggleBootStart(paused, true).body).toBe(indented);
  });

  it('comments a hand-edited multi-target WantedBy= line as one unit', () => {
    const multi = `[Install]\nWantedBy=multi-user.target default.target\n`;
    const paused = toggleBootStart(multi, false).body;
    expect(paused).toContain('#SK-PAUSED# WantedBy=multi-user.target default.target');
    expect(toggleBootStart(paused, true).body).toBe(multi);
  });

  it('throws when enabling a Quadlet that has no [Install] WantedBy= line', () => {
    expect(() => toggleBootStart('[Install]\nAlias=sk.service\n', true)).toThrow(/WantedBy/);
  });

  it('disabling a Quadlet with no WantedBy= is a clean no-op (never throws)', () => {
    const noInstall = `[Container]\nImage=foo:1\n`;
    const { body, changed } = toggleBootStart(noInstall, false);
    expect(changed).toBe(false);
    expect(body).toBe(noInstall);
  });

  it('only toggles WantedBy= inside [Install], ignoring it in other sections', () => {
    // A WantedBy= outside [Install] is not a boot lever (the generator ignores
    // it), so it must be left untouched in BOTH directions — otherwise resume
    // could falsely report success while the unit stays unwired.
    const strayWantedBy = `[Unit]
WantedBy=some-other.target

[Container]
Image=foo:1

[Install]
WantedBy=default.target
`;
    const paused = toggleBootStart(strayWantedBy, false);
    expect(paused.changed).toBe(true);
    // [Unit] line untouched; only the [Install] one is commented.
    expect(paused.body).toContain('WantedBy=some-other.target');
    expect(paused.body).not.toContain('#SK-PAUSED# WantedBy=some-other.target');
    expect(paused.body).toContain('#SK-PAUSED# WantedBy=default.target');
    // Round-trips back exactly, stray line still untouched.
    expect(toggleBootStart(paused.body, true).body).toBe(strayWantedBy);
  });

  it('enabling throws when the only WantedBy= is outside [Install]', () => {
    // There is a WantedBy= in the file, but not where it matters — so there is
    // nothing to restore and we must NOT report a phantom success.
    const onlyStray = `[Unit]\nWantedBy=some-other.target\n\n[Install]\nAlias=sk.service\n`;
    expect(() => toggleBootStart(onlyStray, true)).toThrow(/WantedBy/);
  });
});
