import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyToHardware,
  renderHardwareBlock,
  spliceHardwareBlock,
  type HardwareJson,
} from '../src/hardware.js';

const SAMPLE_HW: HardwareJson = {
  detectedAt: '2026-05-22T20:00:00Z',
  serial: [
    {
      byId: '/dev/serial/by-id/usb-Actisense_NGT-1_001',
      vendor: 'Actisense',
      product: 'NGT-1',
      enabled: false,
    },
    { byId: '/dev/serial/by-id/usb-FTDI_AB_002', vendor: 'FTDI', product: 'AB', enabled: true },
  ],
  can: [{ interface: 'can0', type: 'socketcan', enabled: false }],
  bluetooth: { dbusAvailable: true, enabled: false },
  gpio: { platform: 'rpi5', enabled: false },
};

describe('applyToHardware', () => {
  it('enables a serial device by byId', () => {
    const next = applyToHardware(SAMPLE_HW, {
      serial: [{ byId: '/dev/serial/by-id/usb-Actisense_NGT-1_001', enabled: true }],
    });
    expect(next.serial[0].enabled).toBe(true);
    expect(next.serial[1].enabled).toBe(true); // unchanged
  });

  it('toggles can and gpio independently', () => {
    const next = applyToHardware(SAMPLE_HW, {
      can: [{ interface: 'can0', enabled: true }],
      gpio: { enabled: true },
    });
    expect(next.can[0].enabled).toBe(true);
    expect(next.gpio.enabled).toBe(true);
    expect(next.bluetooth.enabled).toBe(false);
  });

  it('leaves unknown serial overrides as no-ops', () => {
    const next = applyToHardware(SAMPLE_HW, {
      serial: [{ byId: '/dev/serial/by-id/nonexistent', enabled: true }],
    });
    expect(next.serial[0].enabled).toBe(false);
    expect(next.serial[1].enabled).toBe(true);
  });
});

describe('renderHardwareBlock', () => {
  it('emits AddDevice for enabled serial only', () => {
    const block = renderHardwareBlock(SAMPLE_HW);
    expect(block).toContain('AddDevice=/dev/serial/by-id/usb-FTDI_AB_002');
    expect(block).not.toContain('AddDevice=/dev/serial/by-id/usb-Actisense_NGT-1_001');
  });

  it('emits the dbus-proxy socket volume when bluetooth enabled + dbusAvailable', () => {
    const hw = { ...SAMPLE_HW, bluetooth: { dbusAvailable: true, enabled: true } };
    const block = renderHardwareBlock(hw);
    expect(block).toContain('Volume=signalk-dbus-socket:/run/dbus:rw');
    // The legacy direct bind mount cannot authenticate across the
    // rootless userns (EXTERNAL auth uid mismatch) — re-emitting it
    // would regress a working `signalk bluetooth enable`.
    expect(block).not.toContain('Volume=/run/dbus:/run/dbus');
  });

  it('omits dbus volume when bluetooth dbusAvailable false', () => {
    const hw = { ...SAMPLE_HW, bluetooth: { dbusAvailable: false, enabled: true } };
    expect(renderHardwareBlock(hw)).not.toContain('signalk-dbus-socket');
  });
});

const SAMPLE_QUADLET = `[Container]
Image=ghcr.io/dirkwa/signalk-server:latest
ContainerName=signalk-server

# === BEGIN HARDWARE (managed by signalk-universal-installer) ===
AddDevice=/dev/serial/by-id/usb-OLD
# === END HARDWARE ===

[Service]
Restart=on-failure
`;

describe('spliceHardwareBlock', () => {
  it('replaces existing HARDWARE block content', () => {
    const out = spliceHardwareBlock(SAMPLE_QUADLET, 'AddDevice=/dev/serial/by-id/usb-NEW');
    expect(out).toContain('AddDevice=/dev/serial/by-id/usb-NEW');
    expect(out).not.toContain('AddDevice=/dev/serial/by-id/usb-OLD');
    expect(out).toContain('Restart=on-failure');
  });

  it('appends markers + block when none exist', () => {
    const bare = `[Container]\nImage=foo:1\n\n[Service]\nRestart=on-failure\n`;
    const out = spliceHardwareBlock(bare, 'AddDevice=/dev/x');
    expect(out).toContain('# === BEGIN HARDWARE');
    expect(out).toContain('AddDevice=/dev/x');
    expect(out).toContain('# === END HARDWARE');
  });
});

describe('readHardware', () => {
  // The candidate field is written host-side by `signalk socketcan`
  // (signalk-universal-installer#72) and must survive readHardware()'s
  // explicit destructure so GET /api/hardware can surface it. The
  // previous destructure dropped any unknown key on the floor.
  it('passes socketcanCandidate through end-to-end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'updater-hardware-'));
    const path = join(dir, 'hardware.json');
    const candidate = {
      writtenAt: '2026-05-30T10:30:00Z',
      hat: 'waveshare-2ch-mcp2515',
      displayName: 'Waveshare 2-CH CAN HAT (dual MCP2515)',
      configTxtOverlays: [
        'dtoverlay=mcp2515-can0,oscillator=16000000,interrupt=25',
        'dtoverlay=mcp2515-can1,oscillator=16000000,interrupt=24',
        'dtoverlay=spi-bcm2835-overlay',
      ],
      bitrate: 250000,
      configApplied: false,
      ipLinkUp: false,
    };
    await writeFile(
      path,
      JSON.stringify({
        serial: [],
        can: [],
        bluetooth: { dbusAvailable: false, enabled: false },
        gpio: { platform: 'none', enabled: false },
        socketcanCandidate: candidate,
      }),
      'utf8',
    );

    const previous = process.env.HARDWARE_PATH;
    process.env.HARDWARE_PATH = path;
    try {
      vi.resetModules();
      const { readHardware } = await import('../src/hardware.js');
      const hw = await readHardware();
      expect(hw.socketcanCandidate).toEqual(candidate);
    } finally {
      if (previous === undefined) delete process.env.HARDWARE_PATH;
      else process.env.HARDWARE_PATH = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
