import { describe, it, expect } from 'vitest';
import { fmtLogTime, logLevelClass, parseLogLine } from './log-parse';

describe('parseLogLine', () => {
  it('returns an empty parse for an empty string', () => {
    const r = parseLogLine('');
    expect(r).toEqual({ time: null, level: '', message: '', raw: '' });
  });

  it('decodes pino JSON with numeric level + epoch ms time', () => {
    const r = parseLogLine('{"level":30,"time":1700000000000,"msg":"hello","pid":42,"v":1}');
    expect(r.level).toBe('info');
    expect(r.message).toBe('hello');
    expect(r.time).toBe(new Date(1700000000000).toISOString());
  });

  it('decodes pino JSON with an ISO-string time without falling back', () => {
    const r = parseLogLine('{"level":30,"time":"2026-05-24T03:30:00Z","msg":"hi"}');
    expect(r.level).toBe('info');
    expect(r.message).toBe('hi');
    expect(r.time).toBe(new Date('2026-05-24T03:30:00Z').toISOString());
  });

  it('decodes pino JSON with a numeric-string time as epoch ms', () => {
    const r = parseLogLine('{"level":30,"time":"1700000000000","msg":"hi"}');
    expect(r.time).toBe(new Date(1700000000000).toISOString());
  });

  it('keeps a JSON parse on track but yields time=null when the time is garbage', () => {
    const r = parseLogLine('{"level":30,"time":"not-a-date","msg":"hi"}');
    expect(r.level).toBe('info');
    expect(r.message).toBe('hi');
    expect(r.time).toBeNull();
  });

  it('appends non-reserved fields to the message', () => {
    const r = parseLogLine(
      '{"level":40,"time":1700000000000,"msg":"oops","reqId":"req-1","err":{"code":42}}',
    );
    expect(r.level).toBe('warn');
    expect(r.message).toContain('oops');
    expect(r.message).toContain('reqId=req-1');
    expect(r.message).toContain('err={"code":42}');
  });

  it('extracts a leading ISO timestamp from bare lines', () => {
    const r = parseLogLine('2026-05-24T03:30:00Z server: handler invoked');
    expect(r.time).toBe('2026-05-24T03:30:00Z');
    expect(r.message).toBe('server: handler invoked');
  });

  it('classifies word-level mentions', () => {
    expect(parseLogLine('something WARN: weird').level).toBe('warn');
    expect(parseLogLine('big ERROR: panic').level).toBe('error');
    expect(parseLogLine('warning: deprecated').level).toBe('warn');
  });

  it('falls back to the raw line when JSON parsing fails', () => {
    const r = parseLogLine('{not valid json');
    expect(r.message).toBe('{not valid json');
  });
});

describe('logLevelClass', () => {
  it('routes error/fatal to text-danger', () => {
    expect(logLevelClass('error')).toBe('text-danger');
    expect(logLevelClass('fatal')).toBe('text-danger');
  });
  it('routes warn to text-warning', () => {
    expect(logLevelClass('warn')).toBe('text-warning');
  });
  it('routes debug/trace to text-muted', () => {
    expect(logLevelClass('debug')).toBe('text-muted');
    expect(logLevelClass('trace')).toBe('text-muted');
  });
  it('leaves info and unknown levels unstyled', () => {
    expect(logLevelClass('info')).toBe('');
    expect(logLevelClass('')).toBe('');
    expect(logLevelClass('whatever')).toBe('');
  });
});

describe('fmtLogTime', () => {
  it('returns empty for null', () => {
    expect(fmtLogTime(null)).toBe('');
  });
  it('formats a real ISO to HH:MM:SS in local time', () => {
    const iso = new Date(2026, 4, 24, 7, 8, 9).toISOString();
    expect(fmtLogTime(iso)).toBe('07:08:09');
  });
  it('falls back to a slice for unparseable input', () => {
    // The fallback slices positions 11..18 ("HH:MM:SS" indices in an ISO).
    // For a bogus 18-char input, that yields whatever was at those offsets.
    expect(fmtLogTime('2026-XX-YY hello:world')).toBe('hello:wo');
  });
});
