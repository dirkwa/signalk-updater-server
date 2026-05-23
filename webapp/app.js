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
  } catch (err) {
    document.getElementById('runtime-kind').textContent = 'unreachable';
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
        <span class="tag-digest" title="${escapeHtml(tag.digest)}">${escapeHtml(tag.digest.slice(7, 19))}</span>
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
let logsEventSource = null;

function stopLogsStream() {
  if (logsEventSource) {
    logsEventSource.close();
    logsEventSource = null;
  }
  const btn = document.getElementById('logs-stream');
  btn.textContent = 'Stream';
  btn.classList.remove('btn-primary');
  btn.classList.add('btn-ghost');
}

async function refreshLogs() {
  stopLogsStream();
  const lines = Number.parseInt(document.getElementById('logs-lines').value, 10) || 500;
  const containerSel = document.getElementById('logs-container');
  const name = containerSel ? containerSel.value : 'signalk-server';
  const out = document.getElementById('logs-output');
  out.textContent = 'Loading…';
  try {
    // The one-shot endpoint only ships signalk-server logs; for other
    // containers we fall back to a single-shot read via the SSE
    // endpoint cancelled after the first tail batch arrives. Keeps the
    // refresh button useful for all three containers.
    if (name === 'signalk-server') {
      const res = await fetch(`${ROUTES.signalkLogs}?lines=${lines}`, {
        headers: state.token ? { Authorization: `Bearer ${state.token}` } : undefined,
      });
      const text = await res.text();
      out.textContent = text || '(no log output)';
    } else {
      out.textContent = '(use Stream to view logs for this container)';
    }
    out.scrollTop = out.scrollHeight;
  } catch (err) {
    out.textContent = `Failed to read logs: ${err.message}`;
  }
}

function toggleLogsStream() {
  if (logsEventSource) {
    stopLogsStream();
    return;
  }
  const containerSel = document.getElementById('logs-container');
  const name = containerSel ? containerSel.value : 'signalk-server';
  const tail = Number.parseInt(document.getElementById('logs-lines').value, 10) || 500;
  const out = document.getElementById('logs-output');
  out.textContent = '';
  // EventSource cannot set Authorization headers; the SSE endpoint
  // is on the same origin as the SPA and only reachable from clients
  // that already crossed the engine's PublishPort boundary.
  const es = new EventSource(ROUTES.logsStream(name, tail));
  logsEventSource = es;
  es.onmessage = (ev) => {
    out.textContent += ev.data + '\n';
    out.scrollTop = out.scrollHeight;
  };
  es.addEventListener('end', () => {
    out.textContent += '\n[stream ended]\n';
    stopLogsStream();
  });
  es.addEventListener('error', () => {
    out.textContent += '\n[stream error — disconnected]\n';
    stopLogsStream();
  });
  const btn = document.getElementById('logs-stream');
  btn.textContent = 'Stop streaming';
  btn.classList.remove('btn-ghost');
  btn.classList.add('btn-primary');
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
    const onOk = () => {
      dialog.close();
      cleanup();
      resolve({
        confirmed: true,
        skipBackup: document.getElementById('confirm-skip-backup').checked,
      });
    };
    const onCancel = () => {
      dialog.close();
      cleanup();
      resolve({ confirmed: false });
    };
    function cleanup() {
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
    }
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
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
  if (name === 'logs') refreshLogs();
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
  document.getElementById('logs-refresh').addEventListener('click', () => refreshLogs());
  document.getElementById('logs-stream').addEventListener('click', () => toggleLogsStream());
  document.getElementById('logs-container').addEventListener('change', () => {
    stopLogsStream();
    refreshLogs();
  });
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
}

boot();
