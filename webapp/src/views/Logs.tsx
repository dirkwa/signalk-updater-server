import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, ButtonGroup, Form, FormGroup, Input, Label } from 'reactstrap';
import { fmtLogTime, logLevelClass, parseLogLine } from '../log-parse';

type Container = 'signalk-server' | 'signalk-updater-server' | 'signalk-doctor-server';

const CONTAINERS: Container[] = [
  'signalk-server',
  'signalk-updater-server',
  'signalk-doctor-server',
];

type LogStatus = 'connecting' | 'connected' | 'paused' | 'disconnected' | 'error';

// Keep the rendered DOM bounded; the broker server-side keeps its own
// ring buffer so a fresh reconnect can backfill if the user needs more.
const MAX_ROWS = 2000;
const SCROLL_SLACK = 30;

interface LogRow {
  id: number;
  time: string | null;
  level: string;
  message: string;
}

export function Logs() {
  const [container, setContainer] = useState<Container>('signalk-server');
  const [lines, setLines] = useState(500);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [status, setStatus] = useState<LogStatus>('disconnected');
  // Bumped to force a reconnect (e.g. on page-becomes-visible after a
  // teardown). Equivalent to "key" but local to this effect.
  const [reconnectToken, setReconnectToken] = useState(0);
  // Pause is held in a ref so the SSE onmessage handler can read the
  // current value without resubscribing every time the user toggles.
  const pausedRef = useRef(false);
  const [paused, setPaused] = useState(false);

  const outRef = useRef<HTMLDivElement | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const nextIdRef = useRef(0);

  const togglePause = useCallback((): void => {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
    setStatus((s) => (pausedRef.current ? 'paused' : s === 'paused' ? 'connected' : s));
  }, []);

  const clear = useCallback((): void => {
    setRows([]);
  }, []);

  const teardown = useCallback((): void => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setStatus('disconnected');
  }, []);

  // (Re)connect whenever the container or line count changes. The
  // server-side broker replays its ring buffer on connect, so a
  // fresh subscriber gets immediate context.
  useEffect(() => {
    teardown();
    setRows([]);
    setStatus('connecting');
    // EventSource can't set Authorization headers — the SSE endpoint
    // is on the same origin as the SPA and the engine listens on a
    // single PublishPort, so any client that reached it has already
    // crossed the auth boundary.
    const url = `/api/containers/${encodeURIComponent(container)}/logs/stream?tail=${lines}`;
    const es = new EventSource(url);
    esRef.current = es;
    es.onopen = (): void => setStatus(pausedRef.current ? 'paused' : 'connected');
    es.onmessage = (ev: MessageEvent<string>): void => {
      if (pausedRef.current) return;
      const parsed = parseLogLine(ev.data);
      const id = nextIdRef.current++;
      setRows((prev) => {
        const next = prev.length >= MAX_ROWS ? prev.slice(prev.length - MAX_ROWS + 1) : prev;
        return [...next, { id, time: parsed.time, level: parsed.level, message: parsed.message }];
      });
    };
    es.addEventListener('end', (ev): void => {
      const data = ev instanceof MessageEvent && typeof ev.data === 'string' ? ev.data : 'closed';
      const id = nextIdRef.current++;
      setRows((prev) => [
        ...prev,
        { id, time: null, level: '', message: `[stream ended: ${data}]` },
      ]);
      teardown();
    });
    es.addEventListener('error', (): void => {
      // EventSource auto-reconnects on transient errors; we only flip
      // the pill so the user knows the stream blipped.
      setStatus('error');
    });
    return () => {
      es.close();
      esRef.current = null;
    };
  }, [container, lines, reconnectToken, teardown]);

  // Suspend the stream when the page is hidden (background tab, lid
  // closed). Resumes when visible again by bumping the reconnect
  // token, which re-runs the connect effect above.
  useEffect(() => {
    const onVis = (): void => {
      if (document.hidden) {
        teardown();
      } else if (esRef.current === null) {
        setReconnectToken((n) => n + 1);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [teardown]);

  // Auto-scroll only when the user is already at the bottom — if
  // they've scrolled up to read history, don't yank them back.
  useEffect(() => {
    const el = outRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - SCROLL_SLACK;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [rows]);

  return (
    <>
      <Form className="d-flex flex-wrap gap-3 align-items-end mb-3">
        <FormGroup className="mb-0">
          <Label for="logs-container" className="small text-muted mb-1">
            Container
          </Label>
          <Input
            id="logs-container"
            type="select"
            bsSize="sm"
            value={container}
            onChange={(e) => setContainer(e.target.value as Container)}
          >
            {CONTAINERS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Input>
        </FormGroup>
        <FormGroup className="mb-0">
          <Label for="logs-lines" className="small text-muted mb-1">
            Tail lines
          </Label>
          <Input
            id="logs-lines"
            type="number"
            bsSize="sm"
            min={50}
            max={5000}
            value={lines}
            onChange={(e) => {
              const v = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(v) && v >= 50 && v <= 5000) setLines(v);
            }}
            style={{ maxWidth: '7rem' }}
          />
        </FormGroup>
        <StatusPill status={status} />
        <ButtonGroup size="sm" className="ms-auto">
          <Button color={paused ? 'primary' : 'secondary'} outline={!paused} onClick={togglePause}>
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button color="secondary" outline onClick={clear}>
            Clear
          </Button>
        </ButtonGroup>
      </Form>

      <div
        ref={outRef}
        className="border rounded p-2 font-monospace small"
        style={{
          maxHeight: '60vh',
          overflowY: 'auto',
          background: 'var(--bs-body-bg)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
        aria-live="polite"
        aria-label="Container logs"
      >
        {rows.length === 0 ? (
          <div className="text-muted">Connecting…</div>
        ) : (
          rows.map((r) => (
            <div key={r.id} className={`d-flex gap-2 ${logLevelClass(r.level)}`}>
              <span className="text-muted flex-shrink-0" style={{ width: '5rem' }}>
                {fmtLogTime(r.time)}
              </span>
              <span className="text-muted flex-shrink-0" style={{ width: '3.5rem' }}>
                {r.level}
              </span>
              <span className="flex-grow-1">{r.message}</span>
            </div>
          ))
        )}
      </div>
    </>
  );
}

function StatusPill({ status }: { status: LogStatus }) {
  const color =
    status === 'connected'
      ? 'success'
      : status === 'paused'
        ? 'warning'
        : status === 'connecting'
          ? 'info'
          : status === 'error'
            ? 'danger'
            : 'secondary';
  return (
    <Badge color={color} className="align-self-center">
      {status}
    </Badge>
  );
}
