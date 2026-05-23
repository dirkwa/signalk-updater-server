// SignalK Updater — single-page console.
//
// No framework, no build step. The whole UI is hand-wired against the
// engine's REST endpoints. Three tabs, each backed by a render function
// that the tab switcher activates.

const ROUTES = {
  session: '/api/session',
  health: '/api/health',
  state: '/api/state',
  versions: '/api/versions',
  versionsCheck: '/api/versions/check',
  versionsSwitch: '/api/versions/switch',
  versionsRollback: '/api/versions/rollback',
  signalkLogs: '/api/signalk/logs',
  signalkStart: '/api/signalk/start',
  signalkStop: '/api/signalk/stop',
  signalkRestart: '/api/signalk/restart',
  selfState: '/api/self/state',
  selfUpdate: '/api/self/update',
  logsStream: (name, tail) =>
    `/api/containers/${encodeURIComponent(name)}/logs/stream?tail=${tail}`,
  logsOnce: (name, tail) => `/api/containers/${encodeURIComponent(name)}/logs?tail=${tail}`,
};

const CHANNEL_DESCRIPTIONS = {
  stable: 'Production releases — long-tested, recommended for boats in use.',
  beta: 'Pre-release builds — newer features, may have rough edges.',
  master: 'Bleeding edge from the master branch — every commit on signalk-server/main.',
  dirkwa: 'Custom builds maintained in dirkwa/signalk-server.',
};

const state = {
  token: null,
  current: null,
  versions: null,
};

// ── Auth-aware fetch helper ──────────────────────────────
async function api(path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set('Accept', 'application/json');
  if (init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (state.token) {
    // Bearer satisfies the engine's primary auth check; X-SK-Auth forces
    // a CORS preflight so a same-origin drive-by from the SignalK admin
    // UI on a different port can't POST through silently.
    headers.set('Authorization', `Bearer ${state.token}`);
    headers.set('X-SK-Auth', state.token);
  }
  const res = await fetch(path, { ...init, headers });
  if (res.status === 204) return null;
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = (body && body.error) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function loadSession() {
  try {
    const s = await api(ROUTES.session);
    state.token = s?.token ?? null;
  } catch (err) {
    // /api/session is read-only and unauthenticated; a failure here
    // means the token file isn't readable inside the engine container
    // (mount problem, mode bits, …). Show the error but keep the UI
    // running in read-only mode.
    toast(`Session bootstrap failed: ${err.message}`, 'err');
  }
}

// ── Toast helper ─────────────────────────────────────────
let toastTimer = null;
function toast(message, kind = 'info', durationMs = 4000) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast is-${kind}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('is-hidden'), durationMs);
}

// ── Dashboard rendering ──────────────────────────────────
function describeState(s) {
  switch (s) {
    case 'running':
      return 'running';
    case 'starting':
      return 'starting';
    case 'stopped':
      return 'stopped';
    case 'unhealthy':
      return 'unhealthy';
    case 'missing':
      return 'missing';
    default:
      return 'unknown';
  }
}

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function relTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

function renderCard(card, snap) {
  const stateEl = card.querySelector('[data-state]');
  const tagEl = card.querySelector('[data-field=tag]');
  const digestEl = card.querySelector('[data-field=digest]');
  const startedEl = card.querySelector('[data-field=startedAt]');
  const updateEl = card.querySelector('[data-field=updateAvailable]');

  const desc = describeState(snap.state);
  stateEl.textContent = desc;
  stateEl.className = `state state-${desc}`;
  tagEl.textContent = snap.tag || '—';
  digestEl.textContent = snap.digest ? snap.digest.slice(0, 19) + '…' : '—';
  digestEl.title = snap.digest || '';
  startedEl.textContent = snap.startedAt
    ? `${fmtTime(snap.startedAt)} (${relTime(snap.startedAt)})`
    : '—';
  if (updateEl) {
    if (snap.updateAvailable) {
      updateEl.textContent = `Available: ${snap.availableTag ?? 'newer build'}`;
      updateEl.style.color = 'var(--warn)';
    } else {
      updateEl.textContent = 'Up to date';
      updateEl.style.color = '';
    }
    const selfUpdateBtn = card.querySelector('[data-action=self-update]');
    if (selfUpdateBtn) selfUpdateBtn.disabled = !snap.updateAvailable;
  }
}

async function refreshDashboard() {
  try {
    const s = await api(ROUTES.state);
    state.current = s;
    renderCard(document.querySelector('[data-card=signalk-server]'), s.signalkServer);
    renderCard(document.querySelector('[data-card=signalk-updater-server]'), s.updaterServer);
    renderCard(document.querySelector('[data-card=signalk-doctor-server]'), s.doctorServer);
    document.getElementById('last-check').textContent =
      `${fmtTime(s.lastCheck)} (${relTime(s.lastCheck)})`;
  } catch (err) {
    toast(`Failed to load state: ${err.message}`, 'err');
  }
}

async function refreshRuntime() {
  try {
    const h = await api(ROUTES.health);
    document.getElementById('runtime-kind').textContent = h.runtime ?? 'unknown';
    const version = h.version && h.version !== 'unknown' ? `v${h.version}` : '';
    document.getElementById('brand-version').textContent = version || '—';
  } catch (err) {
    document.getElementById('runtime-kind').textContent = 'unreachable';
    document.getElementById('brand-version').textContent = '—';
  }
}

// ── Versions rendering ───────────────────────────────────
function ordChannel(c) {
  // Display order: stable first, then beta, then master, then dirkwa.
  return ['stable', 'beta', 'master', 'dirkwa'].indexOf(c);
}

function renderVersions(data) {
  const container = document.getElementById('channels');
  container.innerHTML = '';

  if (!data || !data.channels) {
    container.innerHTML = '<p class="empty">No tag information available.</p>';
    return;
  }

  document.getElementById('versions-meta').textContent =
    `Last fetched: ${fmtTime(data.cachedAt)} (${relTime(data.cachedAt)})`;

  const currentTag = state.current?.signalkServer.tag;

  const channels = Object.entries(data.channels).sort(([a], [b]) => ordChannel(a) - ordChannel(b));

  for (const [name, tags] of channels) {
    if (tags.length === 0) continue;

    const channel = document.createElement('div');
    channel.className = 'channel';

    const head = document.createElement('div');
    head.className = 'channel-head';
    head.innerHTML = `
      <h3>${escapeHtml(name)}</h3>
      <span class="channel-desc">${escapeHtml(CHANNEL_DESCRIPTIONS[name] ?? '')}</span>
      <span class="channel-count">${tags.length} tag${tags.length === 1 ? '' : 's'}</span>
    `;
    channel.appendChild(head);

    const list = document.createElement('ul');
    list.className = 'tags';

    // Limit display to first 25 per channel; master can be hundreds.
    const visible = tags.slice(0, 25);
    for (const tag of visible) {
      const row = document.createElement('li');
      row.className = 'tag-row';
      const isCurrent = tag.name === currentTag;
      if (isCurrent) row.classList.add('is-current');
      row.innerHTML = `
        <div>
          <span class="tag-name">${escapeHtml(tag.name)}</span>
          ${isCurrent ? '<span class="tag-current-pill">current</span>' : ''}
        </div>
        <span class="tag-pushed">${escapeHtml(relTime(tag.pushedAt) || '—')}</span>
        <span class="tag-digest" title="${escapeHtml(tag.digest ?? '')}">${escapeHtml((tag.digest ?? '').slice(7, 19))}</span>
        <button type="button" class="btn" data-switch-tag="${escapeHtml(tag.name)}" ${isCurrent ? 'disabled' : ''}>
          ${isCurrent ? 'In use' : 'Switch'}
        </button>
      `;
      list.appendChild(row);
    }

    if (tags.length > visible.length) {
      const more = document.createElement('li');
      more.className = 'tag-row';
      more.innerHTML = `<span class="footnote" style="grid-column:1/-1;">… and ${tags.length - visible.length} older ${name} tag${tags.length - visible.length === 1 ? '' : 's'}.</span>`;
      list.appendChild(more);
    }

    channel.appendChild(list);
    container.appendChild(channel);
  }
}

async function refreshVersions(force = false) {
  document.getElementById('versions-meta').textContent = 'Loading…';
  try {
    const url = force ? ROUTES.versionsCheck : ROUTES.versions;
    const data = await api(url, force ? { method: 'POST' } : {});
    state.versions = data;
    renderVersions(data);
  } catch (err) {
    document.getElementById('channels').innerHTML =
      `<p class="empty">Failed to fetch tags: ${escapeHtml(err.message)}</p>`;
    document.getElementById('versions-meta').textContent = '';
  }
}

// ── Logs view ───────────────────────────────────────────
//
// Lifted from the signalk-container log-stream-broker pattern: the
// engine fans a single dockerode follow-stream out to every SSE
// subscriber, plus keeps a 500-line ring buffer per container so a
// freshly attached client gets immediate context. The webapp side
// just renders parsed lines.
let logsEventSource = null;
let logsPaused = false;

const LEVEL_RX_PINO = /"level":(\d+)/; // pino numeric level
const PINO_LEVELS = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const LEVEL_RX_WORD = /\b(trace|debug|info|warn(?:ing)?|error|fatal)\b/i;
const TS_RX_FRONT = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s*/;
const TS_RX_PINO = /"time":(\d{10,13})/;

function parseLogLine(raw) {
  if (!raw) return { time: null, level: '', message: '', raw };
  // pino JSON?
  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw);
      const lvlNum = obj.level;
      const level = PINO_LEVELS[lvlNum] || (typeof lvlNum === 'string' ? lvlNum : '');
      const time = obj.time ? new Date(Number(obj.time)).toISOString() : null;
      const msg = obj.msg || obj.message || '';
      const extras = Object.entries(obj)
        .filter(([k]) => !['level', 'time', 'msg', 'message', 'hostname', 'pid', 'v'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
      return { time, level, message: extras ? `${msg} ${extras}` : msg, raw };
    } catch {
      // Not actually JSON — fall through.
    }
  }
  let line = raw;
  let time = null;
  const tsMatch = line.match(TS_RX_FRONT);
  if (tsMatch) {
    time = tsMatch[1];
    line = line.slice(tsMatch[0].length);
  } else {
    const pinoTs = line.match(TS_RX_PINO);
    if (pinoTs) time = new Date(Number(pinoTs[1])).toISOString();
  }
  let level = '';
  const lvlMatch = line.match(LEVEL_RX_WORD);
  if (lvlMatch) level = lvlMatch[1].toLowerCase().replace('warning', 'warn');
  // pino numeric level inside an embedded JSON fragment.
  if (!level) {
    const num = line.match(LEVEL_RX_PINO);
    if (num) level = PINO_LEVELS[Number(num[1])] || '';
  }
  return { time, level, message: line, raw };
}

function logLevelClass(level) {
  if (level === 'error' || level === 'fatal') return 'log-err';
  if (level === 'warn') return 'log-warn';
  if (level === 'debug' || level === 'trace') return 'log-debug';
  if (level === 'info') return 'log-info';
  return 'log-plain';
}

function fmtLogTime(iso) {
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

function isScrolledNearBottom(el) {
  const slack = 30; // px — accommodates rounding and font baseline
  return el.scrollTop + el.clientHeight >= el.scrollHeight - slack;
}

function appendLogLine(out, raw) {
  const wasAtBottom = isScrolledNearBottom(out);
  const parsed = parseLogLine(raw);
  const row = document.createElement('div');
  row.className = `log-row ${logLevelClass(parsed.level)}`;
  const time = parsed.time ? fmtLogTime(parsed.time) : '';
  row.innerHTML = `<span class="log-time">${escapeHtml(time)}</span><span class="log-level">${escapeHtml(parsed.level || '')}</span><span class="log-msg">${escapeHtml(parsed.message)}</span>`;
  out.appendChild(row);
  // Trim — keep latest ~2000 rows to avoid runaway DOM growth.
  while (out.children.length > 2000) out.removeChild(out.firstChild);
  if (wasAtBottom) out.scrollTop = out.scrollHeight;
}

function clearLogs() {
  const out = document.getElementById('logs-output');
  out.innerHTML = '';
}

function setLogsStatus(state) {
  // state: 'connecting' | 'connected' | 'paused' | 'disconnected' | 'error'
  const el = document.getElementById('logs-status');
  el.textContent = state;
  el.className = `logs-status logs-status-${state}`;
}

function stopLogsStream() {
  if (logsEventSource) {
    logsEventSource.close();
    logsEventSource = null;
  }
  setLogsStatus('disconnected');
}

// Open (or re-open) the SSE stream for the currently-selected container.
// Streaming-by-default: every time the Logs tab activates, the container
// dropdown changes, or the lines input changes, we tear down the
// previous stream and open a fresh one. The broker's ring buffer means
// the new connection gets immediate backfill even on first hit.
function startLogsStream() {
  stopLogsStream();
  const containerSel = document.getElementById('logs-container');
  const name = containerSel ? containerSel.value : 'signalk-server';
  const tail = Number.parseInt(document.getElementById('logs-lines').value, 10) || 500;
  const out = document.getElementById('logs-output');
  clearLogs();
  setLogsStatus('connecting');
  // EventSource cannot set Authorization headers; the SSE endpoint is
  // on the same origin as the SPA and only reachable from clients that
  // already crossed the engine's PublishPort boundary.
  const es = new EventSource(ROUTES.logsStream(name, tail));
  logsEventSource = es;
  es.onopen = () => setLogsStatus(logsPaused ? 'paused' : 'connected');
  es.onmessage = (ev) => {
    if (logsPaused) return;
    appendLogLine(out, ev.data);
  };
  es.addEventListener('end', (ev) => {
    const note = document.createElement('div');
    note.className = 'log-row log-plain';
    note.textContent = `[stream ended: ${ev.data || 'closed'}]`;
    out.appendChild(note);
    stopLogsStream();
  });
  es.addEventListener('error', () => {
    setLogsStatus('error');
    // The browser auto-reconnects an EventSource on transient errors.
    // We only surface the visual hint; if the engine restarts the
    // status will go connecting → connected on its own.
  });
}

function toggleLogsPause() {
  logsPaused = !logsPaused;
  const btn = document.getElementById('logs-pause');
  if (logsPaused) {
    btn.textContent = 'Resume';
    btn.classList.remove('btn-ghost');
    btn.classList.add('btn-primary');
    setLogsStatus('paused');
  } else {
    btn.textContent = 'Pause';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-ghost');
    setLogsStatus(currentLogsStatus());
  }
}

// Map EventSource.readyState back to a status string the pill can
// render. Per WHATWG: 0 = CONNECTING, 1 = OPEN, 2 = CLOSED. We avoid
// relying on the EventSource constants because the variable might be
// null (e.g. just torn down) and the browser-provided enum doesn't
// add anything over the integer compare.
function currentLogsStatus() {
  if (!logsEventSource) return 'disconnected';
  if (logsEventSource.readyState === 1) return 'connected';
  if (logsEventSource.readyState === 0) return 'connecting';
  return 'disconnected';
}

// ── Self-update ──────────────────────────────────────────
async function refreshSelfState() {
  try {
    const s = await api(ROUTES.selfState);
    const card = document.querySelector('[data-card=signalk-updater-server]');
    const btn = card.querySelector('[data-action=self-update]');
    const updateEl = card.querySelector('[data-field=updateAvailable]');
    if (s.updateAvailable && s.availableTag) {
      btn.disabled = false;
      btn.dataset.selfUpdateTag = s.availableTag;
      updateEl.textContent = `Available: ${s.availableTag}`;
      updateEl.style.color = 'var(--warn)';
    } else {
      btn.disabled = true;
      delete btn.dataset.selfUpdateTag;
      updateEl.textContent = `Up to date (${s.currentTag})`;
      updateEl.style.color = '';
    }
  } catch (err) {
    // Soft-fail: leave the existing dashboard state intact.
  }
}

async function doSelfUpdate() {
  const card = document.querySelector('[data-card=signalk-updater-server]');
  const btn = card.querySelector('[data-action=self-update]');
  const tag = btn.dataset.selfUpdateTag;
  if (!tag) return;
  const r = await showConfirm({
    title: `Self-update to ${tag}?`,
    body: 'The updater will pull the new image, rewrite its own Quadlet, and restart. The browser will lose its connection for ~30s; refresh the page once it returns. signalk-server is not touched.',
    okLabel: 'Update',
  });
  if (!r.confirmed) return;
  try {
    toast(`Self-updating to ${tag}…`, 'info', 30000);
    await api(ROUTES.selfUpdate, { method: 'POST', body: JSON.stringify({ tag }) });
    toast(`Self-update kicked off — wait for restart`, 'ok');
  } catch (err) {
    toast(`Self-update failed: ${err.message}`, 'err', 8000);
  }
}

// ── Modal helpers ────────────────────────────────────────
function showConfirm({ title, body, okLabel = 'OK', showSkipBackup = false }) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('confirm-modal');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-body').textContent = body;
    document.getElementById('confirm-ok').textContent = okLabel;
    document.querySelector('#confirm-modal .checkbox').style.display = showSkipBackup ? '' : 'none';
    document.getElementById('confirm-skip-backup').checked = false;
    dialog.showModal();
    const ok = document.getElementById('confirm-ok');
    const cancel = document.getElementById('confirm-cancel');
    // The HTMLDialogElement closes itself on Esc (and on a backdrop
    // click in some browsers) without firing our button listeners.
    // Without the dialog 'cancel'/'close' handlers below, that path
    // would leave the Promise unresolved — and because we reuse the
    // same dialog instance for every confirm, the next showConfirm
    // call would hang silently. Track whether we've already settled
    // and route every dismissal path through finish().
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onOk = () => {
      dialog.close();
      finish({
        confirmed: true,
        skipBackup: document.getElementById('confirm-skip-backup').checked,
      });
    };
    const onCancel = () => {
      dialog.close();
      finish({ confirmed: false });
    };
    const onDialogCancel = (ev) => {
      // Prevent the default action so the dialog closes cleanly via
      // the same .close() path the buttons take.
      ev.preventDefault();
      dialog.close();
      finish({ confirmed: false });
    };
    const onDialogClose = () => finish({ confirmed: false });
    function cleanup() {
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      dialog.removeEventListener('cancel', onDialogCancel);
      dialog.removeEventListener('close', onDialogClose);
    }
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    dialog.addEventListener('cancel', onDialogCancel);
    dialog.addEventListener('close', onDialogClose);
  });
}

// ── Actions ─────────────────────────────────────────────
async function doLifecycle(action) {
  const path = {
    start: ROUTES.signalkStart,
    stop: ROUTES.signalkStop,
    restart: ROUTES.signalkRestart,
  }[action];
  if (!path) return;
  const verb = action[0].toUpperCase() + action.slice(1);
  if (action === 'stop' || action === 'restart') {
    const r = await showConfirm({
      title: `${verb} signalk-server?`,
      body: `This will ${action} the signalk-server container. Plotters, AIS feeds, and instruments will be ${action === 'restart' ? 'briefly' : ''} disconnected.`,
      okLabel: verb,
    });
    if (!r.confirmed) return;
  }
  try {
    toast(`${verb}ing signalk-server…`, 'info');
    await api(path, { method: 'POST' });
    toast(`${verb} request sent`, 'ok');
    setTimeout(refreshDashboard, 1500);
  } catch (err) {
    toast(`${verb} failed: ${err.message}`, 'err');
  }
}

async function doSwitch(tag) {
  const r = await showConfirm({
    title: `Switch to ${tag}?`,
    body: `signalk-server will be stopped, the new image pulled, and the container restarted on the new tag. A pre-switch backup runs if signalk-backup is installed. Estimated downtime: 30–90s.`,
    okLabel: 'Switch',
    showSkipBackup: true,
  });
  if (!r.confirmed) return;
  try {
    toast(`Switching to ${tag}…`, 'info', 30000);
    const result = await api(ROUTES.versionsSwitch, {
      method: 'POST',
      body: JSON.stringify({ tag, skipBackup: r.skipBackup }),
    });
    if (result.rolledBack) {
      toast(`Switch failed; rolled back to ${result.from}. ${result.error ?? ''}`, 'err', 8000);
    } else if (result.ok) {
      toast(`Switched to ${result.to} in ${Math.round(result.durationMs / 100) / 10}s`, 'ok');
    } else {
      toast(`Switch returned: ${result.error ?? 'unknown failure'}`, 'err');
    }
    setTimeout(refreshDashboard, 1500);
  } catch (err) {
    toast(`Switch failed: ${err.message}`, 'err', 8000);
  }
}

// ── Tab switching ────────────────────────────────────────
function activateTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('is-active', t.dataset.tab === name);
  });
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('is-hidden', v.id !== `view-${name}`);
  });

  if (name === 'versions' && !state.versions) refreshVersions(false);
  if (name === 'logs') {
    startLogsStream();
  } else {
    // Tear the SSE down so a logs tab left in the background doesn't
    // keep DOM updates ticking and doesn't hold the broker open if
    // it's the only subscriber.
    stopLogsStream();
  }
}

// ── Helpers ─────────────────────────────────────────────
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// ── Boot ────────────────────────────────────────────────
async function boot() {
  // Wire tabs.
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });

  // Card lifecycle buttons.
  document.querySelectorAll('[data-card=signalk-server] [data-action]').forEach((btn) => {
    btn.addEventListener('click', () => doLifecycle(btn.dataset.action));
  });

  // Versions list click delegation.
  document.getElementById('channels').addEventListener('click', (ev) => {
    const target = ev.target;
    if (target && target.dataset && target.dataset.switchTag) {
      doSwitch(target.dataset.switchTag);
    }
  });

  document.getElementById('versions-check').addEventListener('click', () => refreshVersions(true));
  document.getElementById('logs-pause').addEventListener('click', () => toggleLogsPause());
  document.getElementById('logs-clear').addEventListener('click', () => clearLogs());
  document.getElementById('logs-container').addEventListener('change', () => startLogsStream());
  document.getElementById('logs-lines').addEventListener('change', () => startLogsStream());
  document.getElementById('refresh').addEventListener('click', () => {
    refreshDashboard();
    refreshRuntime();
    refreshSelfState();
  });

  // Self-update button on the updater card.
  document
    .querySelector('[data-card=signalk-updater-server] [data-action=self-update]')
    .addEventListener('click', doSelfUpdate);

  // Open Doctor Console — port 3004 on the same host.
  const link = document.getElementById('open-doctor');
  link.href = `${window.location.protocol}//${window.location.hostname}:3004/`;

  await loadSession();
  await Promise.all([refreshDashboard(), refreshRuntime(), refreshSelfState()]);

  // Light polling: dashboard auto-refresh every 5s while tab is visible.
  setInterval(() => {
    if (
      !document.hidden &&
      !document.getElementById('view-dashboard').classList.contains('is-hidden')
    ) {
      refreshDashboard();
    }
  }, 5000);

  // Suspend the logs SSE when the page is hidden (browser tab in
  // background, laptop lid closed, …). The broker keeps running
  // server-side, the user just stops paying for DOM updates they
  // can't see. Resumes automatically when the page becomes visible
  // again if the Logs tab is still selected.
  document.addEventListener('visibilitychange', () => {
    const logsVisible = !document.getElementById('view-logs').classList.contains('is-hidden');
    if (!logsVisible) return;
    if (document.hidden) {
      stopLogsStream();
    } else {
      startLogsStream();
    }
  });
}

boot();
