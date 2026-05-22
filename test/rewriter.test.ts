import { describe, it, expect } from 'vitest';
import { rewriteImageLine } from '../src/quadlet/rewriter.js';

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
