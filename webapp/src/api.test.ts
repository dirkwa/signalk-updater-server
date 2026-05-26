// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { readApiBase } from './api';

describe('readApiBase', () => {
  afterEach(() => {
    document.querySelectorAll('meta[name="api-base"]').forEach((m) => {
      m.remove();
    });
  });

  it('returns empty string when no meta tag is present', () => {
    expect(readApiBase()).toBe('');
  });

  it('returns the meta tag content when present', () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'api-base');
    meta.setAttribute('content', '/plugins/signalk-updater/console');
    document.head.appendChild(meta);
    expect(readApiBase()).toBe('/plugins/signalk-updater/console');
  });

  it('strips a single trailing slash', () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'api-base');
    meta.setAttribute('content', '/p/');
    document.head.appendChild(meta);
    expect(readApiBase()).toBe('/p');
  });

  it('strips multiple trailing slashes', () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'api-base');
    meta.setAttribute('content', '/p///');
    document.head.appendChild(meta);
    expect(readApiBase()).toBe('/p');
  });

  it('treats an empty content attribute as standalone', () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'api-base');
    meta.setAttribute('content', '');
    document.head.appendChild(meta);
    expect(readApiBase()).toBe('');
  });
});
