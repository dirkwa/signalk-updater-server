import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyToHardware,
  carriedHardwareLines,
  hasSerialDevicesBlock,
  passesGpioAtStart,
  renderHardwareBlock,
  renderSerialDevicesBlock,
  spliceHardwareBlock,
  spliceSerialDevicesBlock,
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

describe('renderHardwareBlock and the SERIAL DEVICES block (installer#309)', () => {
  const HW: HardwareJson = {
    ...SAMPLE_HW,
    can: [{ interface: 'can0', type: 'socketcan', enabled: true }],
    onboardSerial: [
      { device: '/dev/ttyAMA4', label: 'HALPI2 RS-485', enabled: true },
      { device: '/dev/ttyAMA5', label: 'off', enabled: false },
    ],
  };

  it('emits no AddDevice for serial devices when the Quadlet has the block', () => {
    const block = renderHardwareBlock(HW, { serialInService: true });
    expect(block).not.toContain('AddDevice=');
  });

  it('emits no line for an enabled CAN interface', () => {
    // /dev/can0 does not exist: podman fails every start on it (exit 125).
    expect(renderHardwareBlock(HW, { serialInService: true })).not.toContain('can0');
    expect(renderHardwareBlock(HW)).not.toContain('can0');
  });

  it('emits both forms per by-id path and one per onboard UART without the block', () => {
    const lines = renderHardwareBlock(HW).split('\n');
    const id = '/dev/serial/by-id/usb-FTDI_AB_002';
    expect(lines).toContain(`AddDevice=${id}:${id}`);
    expect(lines).toContain(`AddDevice=${id}`);
    expect(lines.filter((l) => l.includes('/dev/ttyAMA4'))).toEqual(['AddDevice=/dev/ttyAMA4']);
    expect(lines.join('\n')).not.toContain('ttyAMA5');
  });

  it('appends carried lines after the lines it renders', () => {
    const hw = { ...HW, gpio: { platform: 'rpi4', enabled: true } };
    const block = renderHardwareBlock(hw, {
      serialInService: true,
      carried: ['Volume=/dev/snd:/dev/snd:ro'],
    });
    expect(block.split('\n')).toEqual([
      'Volume=/dev/gpiomem:/dev/gpiomem',
      'Volume=/dev/snd:/dev/snd:ro',
    ]);
  });

  it('lists enabled serial, then onboardSerial devices, in renderSerialDevicesBlock', () => {
    expect(renderSerialDevicesBlock(HW)).toBe(
      'Environment="SIGNALK_SERIAL_DEVICES=/dev/serial/by-id/usb-FTDI_AB_002 /dev/ttyAMA4"',
    );
  });

  it('names a path with a space in a comment instead of listing it', () => {
    const hw: HardwareJson = {
      ...SAMPLE_HW,
      serial: [{ byId: '/dev/serial/by-id/usb-ODD ADAPTER-if00', enabled: true }],
    };
    expect(renderSerialDevicesBlock(hw)).toBe(
      '# serial device not passed (unsupported characters): /dev/serial/by-id/usb-ODD ADAPTER-if00',
    );
  });

  it('renders an empty SERIAL DEVICES block when nothing is enabled', () => {
    const hw: HardwareJson = { ...SAMPLE_HW, serial: [] };
    expect(renderSerialDevicesBlock(hw)).toBe('');
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

const INSTALLER_QUADLET = `[Container]
Image=ghcr.io/dirkwa/signalk-server:dirkwa

# === BEGIN HARDWARE (managed by signalk-universal-installer) ===
AddDevice=/dev/can0
Volume=signalk-dbus-socket:/run/dbus:rw
Volume=/dev/snd:/dev/snd:ro
# /dev/input view SKIPPED: this user is in the host 'input' group.
Volume=/run/avahi-daemon/socket:/run/avahi-daemon/socket:ro

# === END HARDWARE ===

PodmanArgs=$SIGNALK_DEVICE_ARGS

[Service]
# === BEGIN SERIAL DEVICES (managed by signalk-universal-installer) ===
Environment="SIGNALK_SERIAL_DEVICES=/dev/serial/by-id/usb-OLD"
# === END SERIAL DEVICES ===
EnvironmentFile=-%t/signalk-server-devices.env
`;

describe('Quadlet blocks from the installer template', () => {
  it('carries the probe-derived HARDWARE lines and drops the ones rendered here', () => {
    expect(carriedHardwareLines(INSTALLER_QUADLET)).toEqual([
      'Volume=/dev/snd:/dev/snd:ro',
      "# /dev/input view SKIPPED: this user is in the host 'input' group.",
      'Volume=/run/avahi-daemon/socket:/run/avahi-daemon/socket:ro',
    ]);
  });

  it('drops a direct /run/dbus mount from an older installer instead of carrying it', () => {
    const old = INSTALLER_QUADLET.replace(
      'Volume=signalk-dbus-socket:/run/dbus:rw',
      'Volume=/run/dbus:/run/dbus:ro',
    );
    expect(carriedHardwareLines(old).join('\n')).not.toContain('/run/dbus');
  });

  it('detects the SERIAL DEVICES block', () => {
    expect(hasSerialDevicesBlock(INSTALLER_QUADLET)).toBe(true);
    expect(hasSerialDevicesBlock(SAMPLE_QUADLET)).toBe(false);
  });

  it('replaces the SERIAL DEVICES content and keeps the rest', () => {
    const out = spliceSerialDevicesBlock(
      INSTALLER_QUADLET,
      'Environment="SIGNALK_SERIAL_DEVICES=/dev/serial/by-id/usb-NEW"',
    );
    expect(out).toContain('SIGNALK_SERIAL_DEVICES=/dev/serial/by-id/usb-NEW');
    expect(out).not.toContain('usb-OLD');
    expect(out).toContain('EnvironmentFile=-%t/signalk-server-devices.env');
  });

  it('leaves a Quadlet without the SERIAL DEVICES block unchanged', () => {
    expect(spliceSerialDevicesBlock(SAMPLE_QUADLET, 'Environment="X=1"')).toBe(SAMPLE_QUADLET);
  });
});

describe('GPIO nodes passed at start (installer Pi 5 GPIO change)', () => {
  const GPIO_QUADLET = INSTALLER_QUADLET.replace(
    'EnvironmentFile=-%t/signalk-server-devices.env',
    [
      'EnvironmentFile=-%t/signalk-server-devices.env',
      "ExecStartPre=/bin/sh -c 'args=; \\",
      '    if [ "$${SIGNALK_GPIO:-}" = 1 ]; then \\',
      '        for d in /dev/gpiomem /dev/gpiomem[0-9]* /dev/gpiochip[0-9]*; do [ -e "$$d" ] || continue; args="$$args --device $$d"; done; \\',
      "    fi; exit 0'",
    ].join('\n'),
  );
  const HW: HardwareJson = { ...SAMPLE_HW, gpio: { platform: 'rpi5', enabled: true } };

  it('tells a template that passes GPIO at start from one that does not', () => {
    expect(passesGpioAtStart(GPIO_QUADLET)).toBe(true);
    expect(passesGpioAtStart(INSTALLER_QUADLET)).toBe(false);
    expect(passesGpioAtStart(SAMPLE_QUADLET)).toBe(false);
  });

  it('does not take a comment or an applied flag for the start script', () => {
    const flagged = spliceSerialDevicesBlock(
      INSTALLER_QUADLET.replace('[Service]', '[Service]\n# With SIGNALK_GPIO=1 it also passes ...'),
      'Environment="SIGNALK_GPIO=1"',
    );
    expect(passesGpioAtStart(flagged)).toBe(false);
  });

  it('reads the start script across CRLF line ends and comment lines', () => {
    const crlf = GPIO_QUADLET.replace(
      '    if [ "$${SIGNALK_GPIO',
      '# passes the GPIO nodes\n    if [ "$${SIGNALK_GPIO',
    ).replace(/\n/g, '\r\n');
    expect(passesGpioAtStart(crlf)).toBe(true);
  });

  it('does not take another directive naming the flag for the start script', () => {
    const other = INSTALLER_QUADLET.replace(
      '[Service]',
      '[Service]\nEnvironmentFile=-%t/SIGNALK_GPIO.env',
    );
    expect(passesGpioAtStart(other)).toBe(false);
  });

  it('renders SIGNALK_GPIO=1 after the serial list and no gpiomem volume', () => {
    expect(renderHardwareBlock(HW, { serialInService: true, gpioInService: true })).not.toContain(
      'gpiomem',
    );
    expect(renderSerialDevicesBlock(HW, { gpioInService: true }).split('\n')).toEqual([
      'Environment="SIGNALK_SERIAL_DEVICES=/dev/serial/by-id/usb-FTDI_AB_002"',
      'Environment="SIGNALK_GPIO=1"',
    ]);
  });

  it('keeps the gpiomem volume for a template that predates SIGNALK_GPIO', () => {
    const pi4 = { ...HW, gpio: { platform: 'rpi4', enabled: true } };
    expect(renderHardwareBlock(pi4, { serialInService: true }).split('\n')).toContain(
      'Volume=/dev/gpiomem:/dev/gpiomem',
    );
    expect(renderSerialDevicesBlock(HW)).not.toContain('SIGNALK_GPIO');
  });

  it('writes no gpiomem volume on a Pi 5, which has no /dev/gpiomem', () => {
    expect(renderHardwareBlock(HW, { serialInService: true })).not.toContain('gpiomem');
  });

  it('enables GPIO only for the boolean true, like the installer', () => {
    const odd = { ...HW, gpio: { platform: 'rpi4', enabled: 'true' as unknown as boolean } };
    expect(renderSerialDevicesBlock(odd, { gpioInService: true })).not.toContain('SIGNALK_GPIO');
    expect(renderHardwareBlock(odd)).not.toContain('gpiomem');
  });

  it('renders no GPIO line while GPIO is off', () => {
    expect(renderSerialDevicesBlock(SAMPLE_HW, { gpioInService: true })).not.toContain(
      'SIGNALK_GPIO',
    );
  });

  it('drops a gpiomem volume an earlier apply wrote instead of carrying it', () => {
    const old = GPIO_QUADLET.replace(
      'Volume=/dev/snd:/dev/snd:ro',
      'Volume=/dev/gpiomem:/dev/gpiomem\nVolume=/dev/snd:/dev/snd:ro',
    );
    expect(carriedHardwareLines(old).join('\n')).not.toContain('gpiomem');
  });
});

describe('classes this file does not model', () => {
  const extra = {
    audio: { present: true, enabled: false },
    input: { present: true, enabled: true },
    board: { model: 'halpi2', candidate: false, detectedVia: 'i2c' },
    onboardSerial: [{ device: '/dev/ttyAMA4', label: 'HALPI2 RS-485', enabled: true }],
  };

  it('survive applyToHardware', () => {
    const next = applyToHardware({ ...SAMPLE_HW, ...extra }, { gpio: { enabled: true } });
    expect(next.audio).toEqual(extra.audio);
    expect(next.input).toEqual(extra.input);
    expect(next.board).toEqual(extra.board);
    expect(next.onboardSerial).toEqual(extra.onboardSerial);
    expect(next.gpio.enabled).toBe(true);
  });

  it('survive readHardware', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'updater-hardware-'));
    const path = join(dir, 'hardware.json');
    await writeFile(path, JSON.stringify({ ...SAMPLE_HW, ...extra }), 'utf8');
    const previous = process.env.HARDWARE_PATH;
    process.env.HARDWARE_PATH = path;
    try {
      vi.resetModules();
      const { readHardware } = await import('../src/hardware.js');
      const hw = await readHardware();
      expect(hw.audio).toEqual(extra.audio);
      expect(hw.input).toEqual(extra.input);
      expect(hw.board).toEqual(extra.board);
      expect(hw.onboardSerial).toEqual(extra.onboardSerial);
    } finally {
      if (previous === undefined) delete process.env.HARDWARE_PATH;
      else process.env.HARDWARE_PATH = previous;
      await rm(dir, { recursive: true, force: true });
    }
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

  it('returns the defaults for a file that is not a JSON object', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'updater-hardware-'));
    const path = join(dir, 'hardware.json');
    const previous = process.env.HARDWARE_PATH;
    process.env.HARDWARE_PATH = path;
    try {
      vi.resetModules();
      const { readHardware } = await import('../src/hardware.js');
      for (const body of ['[1]', '"ab"', 'null']) {
        await writeFile(path, body, 'utf8');
        expect(await readHardware()).toEqual({
          serial: [],
          can: [],
          bluetooth: { dbusAvailable: false, enabled: false },
          gpio: { platform: 'none', enabled: false },
        });
      }
    } finally {
      if (previous === undefined) delete process.env.HARDWARE_PATH;
      else process.env.HARDWARE_PATH = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
