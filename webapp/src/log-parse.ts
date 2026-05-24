// Log line parser shared between the live SSE stream and any future
// non-streaming tail view. Two formats are handled:
//
//   1. pino JSON ({"level":30,"time":1779…,"msg":"…",…}) — the engine
//      itself and signalk-server emit this.
//   2. Bare lines, with an optional ISO-ish timestamp at the front and
//      a level word ("info"/"warn"/"error"/…) somewhere in the body.
//
// Anything that doesn't match falls through with an empty level and
// the raw line as the message — never throws.

export interface ParsedLogLine {
  time: string | null;
  level: string;
  message: string;
  raw: string;
}

const PINO_LEVELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

const LEVEL_RX_PINO = /"level":(\d+)/;
const LEVEL_RX_WORD = /\b(trace|debug|info|warn(?:ing)?|error|fatal)\b/i;
const TS_RX_FRONT = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s*/;
const TS_RX_PINO = /"time":(\d{10,13})/;

const PINO_RESERVED = new Set(['level', 'time', 'msg', 'message', 'hostname', 'pid', 'v']);

export function parseLogLine(raw: string): ParsedLogLine {
  if (!raw) return { time: null, level: '', message: '', raw };

  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const lvlNum = obj.level;
      let level = '';
      if (typeof lvlNum === 'number' && lvlNum in PINO_LEVELS) {
        level = PINO_LEVELS[lvlNum] ?? '';
      } else if (typeof lvlNum === 'string') {
        level = lvlNum;
      }
      // pino emits epoch-ms numbers, but some consumers (and our own
      // hand-rolled lines in places) hand us either a numeric string or
      // an ISO string. Coerce numerics via Number, ISO strings via the
      // Date string constructor, and guard against Invalid Date so an
      // unparseable value sets time=null instead of throwing through
      // the outer catch and silently dropping the whole JSON parse.
      const timeRaw = obj.time;
      let time: string | null = null;
      if (typeof timeRaw === 'number' || (typeof timeRaw === 'string' && /^\d+$/.test(timeRaw))) {
        const d = new Date(Number(timeRaw));
        if (!Number.isNaN(d.getTime())) time = d.toISOString();
      } else if (typeof timeRaw === 'string') {
        const d = new Date(timeRaw);
        if (!Number.isNaN(d.getTime())) time = d.toISOString();
      }
      const msgRaw = obj.msg ?? obj.message;
      const msg = typeof msgRaw === 'string' ? msgRaw : '';
      const extras = Object.entries(obj)
        .filter(([k]) => !PINO_RESERVED.has(k))
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join(' ');
      return {
        time,
        level,
        message: extras ? `${msg} ${extras}` : msg,
        raw,
      };
    } catch {
      // Not actually JSON — fall through to bare-line parsing.
    }
  }

  let line = raw;
  let time: string | null = null;
  const tsMatch = line.match(TS_RX_FRONT);
  if (tsMatch && tsMatch[1] !== undefined && tsMatch[0] !== undefined) {
    time = tsMatch[1];
    line = line.slice(tsMatch[0].length);
  } else {
    const pinoTs = line.match(TS_RX_PINO);
    if (pinoTs && pinoTs[1] !== undefined) {
      time = new Date(Number(pinoTs[1])).toISOString();
    }
  }
  let level = '';
  const lvlMatch = line.match(LEVEL_RX_WORD);
  if (lvlMatch && lvlMatch[1] !== undefined) {
    level = lvlMatch[1].toLowerCase().replace('warning', 'warn');
  }
  if (!level) {
    const num = line.match(LEVEL_RX_PINO);
    if (num && num[1] !== undefined) {
      level = PINO_LEVELS[Number(num[1])] ?? '';
    }
  }
  return { time, level, message: line, raw };
}

export function logLevelClass(level: string): string {
  if (level === 'error' || level === 'fatal') return 'text-danger';
  if (level === 'warn') return 'text-warning';
  if (level === 'debug' || level === 'trace') return 'text-muted';
  if (level === 'info') return '';
  return '';
}

export function fmtLogTime(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(11, 19);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch {
    return iso.slice(11, 19);
  }
}
