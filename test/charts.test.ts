import { describe, it, expect } from 'vitest';
import {
  applyCharts,
  applyToHardware,
  renderChartsBlock,
  spliceChartsBlock,
  validateChartsHostPathLexical,
  CHARTS_MOUNT_TARGET,
  type HardwareJson,
} from '../src/hardware.js';

const BASE_HW: HardwareJson = {
  serial: [],
  can: [],
  bluetooth: { dbusAvailable: false, enabled: false },
  gpio: { platform: 'none', enabled: false },
};

describe('applyCharts', () => {
  it('sets the charts config, carrying other fields through', () => {
    const hw: HardwareJson = { ...BASE_HW, detectedAt: '2026-06-27T00:00:00Z' };
    const next = applyCharts(hw, { hostPath: '/home/sk/Charts', enabled: true });
    expect(next.charts).toEqual({ hostPath: '/home/sk/Charts', enabled: true });
    expect(next.detectedAt).toBe('2026-06-27T00:00:00Z');
    expect(next.bluetooth).toEqual(hw.bluetooth);
  });
});

describe('applyToHardware charts carry-through', () => {
  it('does NOT drop charts when a hardware-apply touches only devices', () => {
    const hw: HardwareJson = {
      ...BASE_HW,
      charts: { hostPath: '/home/sk/Charts', enabled: true },
    };
    const next = applyToHardware(hw, { bluetooth: { enabled: true } });
    expect(next.charts).toEqual({ hostPath: '/home/sk/Charts', enabled: true });
    expect(next.bluetooth.enabled).toBe(true);
  });

  it('does NOT drop socketcanCandidate either', () => {
    const hw: HardwareJson = {
      ...BASE_HW,
      socketcanCandidate: {
        writtenAt: '2026-06-27T00:00:00Z',
        hat: 'waveshare',
        displayName: 'Waveshare 2-CH CAN',
        configTxtOverlays: ['dtoverlay=mcp2515'],
        bitrate: 250000,
        configApplied: true,
        ipLinkUp: false,
      },
    };
    const next = applyToHardware(hw, { gpio: { enabled: true } });
    expect(next.socketcanCandidate).toEqual(hw.socketcanCandidate);
  });
});

describe('renderChartsBlock', () => {
  it('is empty when charts is unset', () => {
    expect(renderChartsBlock(BASE_HW)).toBe('');
  });

  it('is empty when charts is disabled', () => {
    expect(renderChartsBlock({ ...BASE_HW, charts: { hostPath: '/x', enabled: false } })).toBe('');
  });

  it('is empty when the host path is blank', () => {
    expect(renderChartsBlock({ ...BASE_HW, charts: { hostPath: '   ', enabled: true } })).toBe('');
  });

  it('renders a RW bind (no :Z) plus the env line at the fixed target', () => {
    const block = renderChartsBlock({
      ...BASE_HW,
      charts: { hostPath: '/home/sk/Charts', enabled: true },
    });
    expect(block).toBe(
      `Volume=/home/sk/Charts:${CHARTS_MOUNT_TARGET}\n` +
        `Environment=SIGNALK_CHARTS_HOST_PATH=${CHARTS_MOUNT_TARGET}`,
    );
    // The shared folder must NOT be relabeled (:Z) or mounted read-only (:ro).
    expect(block).not.toContain(':Z');
    expect(block).not.toContain(':ro');
  });

  it('trims surrounding whitespace from the host path', () => {
    const block = renderChartsBlock({
      ...BASE_HW,
      charts: { hostPath: '  /home/sk/Charts  ', enabled: true },
    });
    expect(block).toContain(`Volume=/home/sk/Charts:${CHARTS_MOUNT_TARGET}`);
  });
});

describe('spliceChartsBlock', () => {
  const withMarkers = [
    '[Container]',
    'Image=ghcr.io/dirkwa/signalk-server:dirkwa',
    '',
    '# === BEGIN CHARTS (managed by signalk-universal-installer) ===',
    '# === END CHARTS ===',
    '',
    '[Service]',
    'Restart=always',
    '',
  ].join('\n');

  it('replaces content between existing markers, preserving the rest', () => {
    const out = spliceChartsBlock(withMarkers, 'Volume=/home/sk/Charts:/home/node/charts-host');
    expect(out).toContain('Volume=/home/sk/Charts:/home/node/charts-host');
    expect(out).toContain('Restart=always'); // untouched
    expect(out).toContain('# === BEGIN CHARTS');
    expect(out).toContain('# === END CHARTS');
  });

  it('clears the block when given an empty string (mount removed)', () => {
    const populated = spliceChartsBlock(
      withMarkers,
      'Volume=/home/sk/Charts:/home/node/charts-host',
    );
    const cleared = spliceChartsBlock(populated, '');
    expect(cleared).not.toContain('Volume=/home/sk/Charts');
    expect(cleared).toContain('# === BEGIN CHARTS');
    expect(cleared).toContain('# === END CHARTS');
  });

  // The CRITICAL case: a pre-Phase-3 install has NO CHARTS markers, only the
  // HARDWARE markers. The block MUST land inside [Container] (after END
  // HARDWARE), NOT appended after [Install] — where podman silently ignores it.
  const preP3 = [
    '[Container]',
    'Image=ghcr.io/dirkwa/signalk-server:dirkwa',
    'ContainerName=signalk-server',
    '',
    '# === BEGIN HARDWARE (managed by signalk-universal-installer) ===',
    'AddDevice=/dev/ttyUSB0',
    '# === END HARDWARE ===',
    '',
    '[Service]',
    'Restart=always',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');

  it('inserts the block right after END HARDWARE (inside [Container]) when CHARTS markers are absent', () => {
    const out = spliceChartsBlock(preP3, 'Volume=/home/sk/Charts:/home/node/charts-host');
    const lines = out.split('\n');
    const endHw = lines.findIndex((l) => l.startsWith('# === END HARDWARE'));
    const beginCharts = lines.findIndex((l) => l.startsWith('# === BEGIN CHARTS'));
    const serviceIdx = lines.findIndex((l) => l === '[Service]');
    const installIdx = lines.findIndex((l) => l === '[Install]');
    expect(beginCharts).toBeGreaterThan(endHw); // after END HARDWARE
    expect(beginCharts).toBeLessThan(serviceIdx); // still inside [Container]
    // The Volume= line is before [Install], so podman parses it under [Container].
    const volIdx = lines.findIndex((l) => l.startsWith('Volume=/home/sk/Charts'));
    expect(volIdx).toBeGreaterThan(endHw);
    expect(volIdx).toBeLessThan(installIdx);
  });

  it('throws rather than EOF-append when NEITHER CHARTS nor HARDWARE markers exist', () => {
    const noMarkers = '[Container]\nImage=x\n\n[Install]\nWantedBy=default.target\n';
    expect(() => spliceChartsBlock(noMarkers, 'Volume=/a:/b')).toThrow(/markers/);
  });
});

describe('validateChartsHostPathLexical', () => {
  it('accepts a normal home-subdir path', () => {
    expect(validateChartsHostPathLexical('/home/sk/Charts')).toBeNull();
  });

  it('accepts a removable-media path', () => {
    expect(validateChartsHostPathLexical('/media/usb/Charts')).toBeNull();
    expect(validateChartsHostPathLexical('/mnt/charts')).toBeNull();
    expect(validateChartsHostPathLexical('/run/media/sk/stick')).toBeNull();
  });

  it('rejects empty / relative / NUL', () => {
    expect(validateChartsHostPathLexical('')).toMatch(/empty/);
    expect(validateChartsHostPathLexical('relative/path')).toMatch(/absolute/);
    // NUL is a control character (caught by the control-char guard).
    expect(validateChartsHostPathLexical('/a/\0/b')).toMatch(/control/);
  });

  it('rejects ".." traversal', () => {
    expect(validateChartsHostPathLexical('/home/sk/../../etc')).toMatch(/\.\./);
  });

  it('rejects a ":" that would corrupt the Volume= parse', () => {
    expect(validateChartsHostPathLexical('/home/sk/a:b/Charts')).toMatch(/":"/);
  });

  it('rejects a newline/CR that would inject a Quadlet directive', () => {
    expect(validateChartsHostPathLexical('/home/sk/Charts\nLabel=evil')).toMatch(/control/);
    expect(validateChartsHostPathLexical('/home/sk/Charts\rLabel=evil')).toMatch(/control/);
  });

  it('denies system roots + secrets case-INSENSITIVELY', () => {
    expect(validateChartsHostPathLexical('/ETC/passwd')).not.toBeNull();
    expect(validateChartsHostPathLexical('/home/sk/.SSH')).toMatch(/Signal K/);
    expect(validateChartsHostPathLexical('/home/sk/.Config/x')).toMatch(/Signal K/);
    expect(validateChartsHostPathLexical('/home/sk/.SignalK-updater')).toMatch(/Signal K/);
  });

  it('rejects system roots and their descendants', () => {
    for (const p of [
      '/',
      '/etc',
      '/etc/passwd',
      '/proc/1',
      '/sys/x',
      '/dev/sda',
      '/var/lib',
      '/root/x',
      '/usr/bin',
    ]) {
      expect(validateChartsHostPathLexical(p), p).not.toBeNull();
    }
  });

  it('rejects /run but allows the /run/media carve-out', () => {
    expect(validateChartsHostPathLexical('/run/secrets')).not.toBeNull();
    expect(validateChartsHostPathLexical('/run/media/sk/stick')).toBeNull();
  });

  it('rejects Signal K data + secrets directories', () => {
    expect(validateChartsHostPathLexical('/home/sk/.signalk')).toMatch(/Signal K/);
    expect(validateChartsHostPathLexical('/home/sk/.signalk-updater/x')).toMatch(/Signal K/);
    expect(validateChartsHostPathLexical('/home/sk/.ssh')).toMatch(/Signal K/);
    expect(validateChartsHostPathLexical('/home/sk/.config/foo')).toMatch(/Signal K/);
  });
});
