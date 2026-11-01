/**
 * API Monitoring & Alert System - backend
 * Concepts: Cron jobs, Logs, Notifications, SQLite, WebSockets
 */
const fs = require('fs');
const path = require('path');

// ---------- tiny .env loader (so Windows users don't need to set env vars) ----------
try {
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  }
} catch (e) { console.error('.env read failed:', e.message); }

const http = require('http');
const express = require('express');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { WebSocketServer } = require('ws');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const LOG_FILE = path.join(__dirname, 'data', 'monitor.log');
const FAILURE_THRESHOLD = 2;   // consecutive failures before DOWN
const SLOW_MS = 1000;          // slower than this = SLOW alert
const SLOW_ALERT_COOLDOWN_MS = 5 * 60 * 1000; // don't spam SLOW alerts
const KEEP_CHECKS_DAYS = 7;

// ---------- logging ----------
function log(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  console.log(line);
  fs.appendFile(LOG_FILE, line + '\n', () => {});
}

// ---------- prepared statements ----------
const q = {
  endpoints: db.prepare('SELECT id, name, url, interval_sec AS intervalSec, created_at AS createdAt FROM endpoints ORDER BY id'),
  endpoint: db.prepare('SELECT id, name, url, interval_sec AS intervalSec FROM endpoints WHERE id = ?'),
  addEndpoint: db.prepare('INSERT INTO endpoints (name, url, interval_sec, created_at) VALUES (?, ?, ?, ?)'),
  delEndpoint: db.prepare('DELETE FROM endpoints WHERE id = ?'),
  addCheck: db.prepare('INSERT INTO checks (endpoint_id, ts, ok, status, ms, error) VALUES (?, ?, ?, ?, ?, ?)'),
  checksSince: db.prepare('SELECT ts, ok, status, ms, error FROM checks WHERE endpoint_id = ? AND ts >= ? ORDER BY ts'),
  recentChecks: db.prepare('SELECT ts, ok, status, ms, error FROM (SELECT * FROM checks WHERE endpoint_id = ? ORDER BY ts DESC LIMIT ?) ORDER BY ts'),
  lastCheck: db.prepare('SELECT ts, ok, status, ms, error FROM checks WHERE endpoint_id = ? ORDER BY ts DESC LIMIT 1'),
  addAlert: db.prepare('INSERT INTO alerts (endpoint_id, name, type, message, ts) VALUES (?, ?, ?, ?, ?)'),
  alerts: db.prepare('SELECT id, endpoint_id AS endpointId, name, type, message, ts FROM alerts ORDER BY ts DESC LIMIT ?'),
  openIncident: db.prepare('SELECT id, started_at FROM incidents WHERE endpoint_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1'),
  startIncident: db.prepare('INSERT INTO incidents (endpoint_id, started_at, reason) VALUES (?, ?, ?)'),
  endIncident: db.prepare('UPDATE incidents SET ended_at = ? WHERE id = ?'),
  incidents: db.prepare(`SELECT i.id, i.endpoint_id AS endpointId, e.name, i.started_at AS startedAt, i.ended_at AS endedAt, i.reason
                         FROM incidents i JOIN endpoints e ON e.id = i.endpoint_id ORDER BY i.started_at DESC LIMIT ?`),
  prune: db.prepare('DELETE FROM checks WHERE ts < ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM endpoints'),
};

// ---------- seed demo endpoints on first run ----------
if (q.count.get().n === 0) {
  const now = Date.now();
  q.addEndpoint.run('Demo API (healthy)', `http://localhost:${PORT}/demo/healthy`, 30, now);
  q.addEndpoint.run('Demo API (flaky)', `http://localhost:${PORT}/demo/flaky`, 30, now);
  q.addEndpoint.run('JSONPlaceholder', 'https://jsonplaceholder.typicode.com/todos/1', 30, now);
}

// ---------- in-memory runtime state (rebuilt from DB on start) ----------
const state = new Map(); // endpointId -> { consecutiveFailures, isDown, lastCheck, lastSlowAlert }
function getState(id) {
  if (!state.has(id)) {
    const last = q.lastCheck.get(id);
    state.set(id, {
      consecutiveFailures: 0,
      isDown: !!q.openIncident.get(id),
      lastCheck: last ? last.ts : 0,
      lastSlowAlert: 0,
    });
  }
  return state.get(id);
}

// ---------- WebSocket (live updates) ----------
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
function broadcast(type, payload = {}) {
  const msg = JSON.stringify({ type, ...payload });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}

// ---------- notifications ----------
const mailer = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: +(process.env.SMTP_PORT || 587),
      secure: +(process.env.SMTP_PORT || 587) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

function channels() {
  return {
    dashboard: true,
    email: !!(mailer && process.env.ALERT_EMAIL_TO),
    telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    webhook: !!process.env.WEBHOOK_URL,
  };
}

const ICON = { DOWN: '🔴', RECOVERED: '🟢', SLOW: '🟠', TEST: '🔔' };

async function sendExternal(type, name, message) {
  const text = `${ICON[type] || ''} [${type}] ${name}\n${message}`;
  const jobs = [];
  if (channels().email) {
    jobs.push(mailer.sendMail({
      from: process.env.SMTP_USER, to: process.env.ALERT_EMAIL_TO,
      subject: `API Monitor: ${type} - ${name}`, text,
    }).then(() => 'email'));
  }
  if (channels().webhook) {
    jobs.push(fetch(process.env.WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, content: text }),
    }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return 'webhook'; }));
  }
  if (channels().telegram) {
    jobs.push(fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text }),
    }).then(async r => { if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120)); return 'telegram'; }));
  }
  const results = await Promise.allSettled(jobs);
  const sent = [], failed = [];
  results.forEach(r => (r.status === 'fulfilled' ? sent.push(r.value) : failed.push(r.reason.message)));
  failed.forEach(f => log('ERROR', 'Notification failed: ' + f));
  return { sent, failed };
}

async function notify(endpoint, type, message) {
  q.addAlert.run(endpoint.id ?? null, endpoint.name, type, message, Date.now());
  log(type === 'DOWN' ? 'ALERT' : 'INFO', `${endpoint.name}: [${type}] ${message}`);
  broadcast('alert', { alertType: type, name: endpoint.name, message });
  return sendExternal(type, endpoint.name, message);
}

// ---------- the checker ----------
async function checkEndpoint(ep) {
  const start = Date.now();
  let result;
  try {
    const res = await fetch(ep.url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'api-monitor/1.0' } });
    result = { ts: start, ok: res.ok, status: res.status, ms: Date.now() - start, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    result = { ts: start, ok: false, status: 0, ms: Date.now() - start, error: e.name === 'TimeoutError' ? 'Timeout (8s)' : (e.cause?.code || e.message) };
  }

  // The endpoint may have been deleted while the request was in flight
  if (!q.endpoint.get(ep.id)) return result;
  q.addCheck.run(ep.id, result.ts, result.ok ? 1 : 0, result.status, result.ms, result.error);

  const st = getState(ep.id);
  st.lastCheck = result.ts;

  if (result.ok) {
    if (st.isDown) {
      st.isDown = false;
      const inc = q.openIncident.get(ep.id);
      let duration = '';
      if (inc) { q.endIncident.run(Date.now(), inc.id); duration = ` after ${fmtDuration(Date.now() - inc.started_at)} of downtime`; }
      st.consecutiveFailures = 0;
      await notify(ep, 'RECOVERED', `Back online (${result.ms}ms)${duration}`);
    } else if (result.ms > SLOW_MS && Date.now() - st.lastSlowAlert > SLOW_ALERT_COOLDOWN_MS) {
      st.lastSlowAlert = Date.now();
      await notify(ep, 'SLOW', `Slow response: ${result.ms}ms (threshold ${SLOW_MS}ms)`);
    }
    st.consecutiveFailures = 0;
  } else {
    st.consecutiveFailures++;
    log('WARN', `${ep.name} check failed (${st.consecutiveFailures}/${FAILURE_THRESHOLD}): ${result.error}`);
    if (!st.isDown && st.consecutiveFailures >= FAILURE_THRESHOLD) {
      st.isDown = true;
      q.startIncident.run(ep.id, Date.now(), result.error);
      await notify(ep, 'DOWN', `Downtime detected: ${result.error}`);
    }
  }
  broadcast('check', { endpointId: ep.id });
  return result;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// Cron: every 5 seconds, run checks for endpoints whose interval has elapsed
const running = new Set();
cron.schedule('*/5 * * * * *', () => {
  const now = Date.now();
  for (const ep of q.endpoints.all()) {
    if (running.has(ep.id)) continue;
    if (now - getState(ep.id).lastCheck >= ep.intervalSec * 1000 - 500) {
      running.add(ep.id);
      checkEndpoint(ep).catch(e => log('ERROR', e.message)).finally(() => running.delete(ep.id));
    }
  }
});
// Cron: hourly cleanup of old check rows
cron.schedule('0 * * * *', () => {
  const r = q.prune.run(Date.now() - KEEP_CHECKS_DAYS * 86400000);
  if (r.changes) log('INFO', `Pruned ${r.changes} old checks`);
});

// ---------- reports ----------
function percentile(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;
}

function summarize(ep, sinceMs) {
  const checks = q.checksSince.all(ep.id, Date.now() - sinceMs);
  const okChecks = checks.filter(c => c.ok);
  const times = okChecks.map(c => c.ms).sort((a, b) => a - b);
  const last = q.lastCheck.get(ep.id);
  const st = getState(ep.id);
  return {
    id: ep.id, name: ep.name, url: ep.url, intervalSec: ep.intervalSec,
    status: !last ? 'PENDING' : st.isDown ? 'DOWN' : 'UP',
    totalChecks: checks.length,
    failedChecks: checks.length - okChecks.length,
    uptimePct: checks.length ? +((okChecks.length / checks.length) * 100).toFixed(2) : null,
    avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
    minMs: times[0] ?? null,
    maxMs: times.length ? times[times.length - 1] : null,
    p95Ms: percentile(times, 95),
    lastCheck: last ? { ...last, ok: !!last.ok } : null,
    recent: q.recentChecks.all(ep.id, 40).map(c => ({ ok: !!c.ok, ms: c.ms, ts: c.ts })),
  };
}

// ---------- web server ----------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Built-in demo targets so the dashboard has something to monitor offline
let flakyDown = false;
app.get('/demo/healthy', (req, res) => setTimeout(() => res.json({ ok: true }), 40 + Math.random() * 160));
app.get('/demo/flaky', (req, res) => {
  if (flakyDown) return res.status(503).json({ error: 'Service Unavailable' });
  setTimeout(() => res.json({ ok: true }), 60 + Math.random() * 500);
});
app.get('/demo/flaky/state', (req, res) => res.json({ down: flakyDown }));
app.post('/demo/flaky/toggle', (req, res) => {
  flakyDown = typeof req.body?.down === 'boolean' ? req.body.down : !flakyDown;
  log('INFO', `Demo flaky API is now ${flakyDown ? 'DOWN' : 'UP'}`);
  res.json({ down: flakyDown });
});

app.get('/api/summary', (req, res) => {
  const hours = Math.max(1, Math.min(168, +req.query.hours || 24));
  res.json({ windowHours: hours, generatedAt: Date.now(), endpoints: q.endpoints.all().map(ep => summarize(ep, hours * 3600000)) });
});

app.get('/api/endpoints/:id/checks', (req, res) => {
  res.json(q.recentChecks.all(+req.params.id, Math.min(500, +req.query.limit || 60)).map(c => ({ ...c, ok: !!c.ok })));
});

app.post('/api/endpoints', (req, res) => {
  const { name, url, intervalSec } = req.body || {};
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'A valid URL (with http/https) is required' }); }
  if (!/^https?:$/.test(parsed.protocol)) return res.status(400).json({ error: 'Only http/https URLs are allowed' });
  const interval = Math.max(10, Math.min(3600, +intervalSec || 30));
  const info = q.addEndpoint.run(String(name || url).slice(0, 60), url, interval, Date.now());
  const ep = q.endpoint.get(info.lastInsertRowid);
  checkEndpoint(ep).catch(() => {});
  broadcast('check', { endpointId: ep.id });
  res.status(201).json(ep);
});

app.delete('/api/endpoints/:id', (req, res) => {
  const id = +req.params.id;
  q.delEndpoint.run(id); // checks + incidents removed by ON DELETE CASCADE
  state.delete(id);
  broadcast('check', { endpointId: id });
  res.json({ ok: true });
});

app.post('/api/endpoints/:id/check', async (req, res) => {
  const ep = q.endpoint.get(+req.params.id);
  if (!ep) return res.status(404).json({ error: 'Not found' });
  res.json(await checkEndpoint(ep));
});

app.get('/api/alerts', (req, res) => res.json(q.alerts.all(Math.min(200, +req.query.limit || 50))));
app.get('/api/incidents', (req, res) => res.json(q.incidents.all(Math.min(200, +req.query.limit || 30))));
app.get('/api/channels', (req, res) => res.json(channels()));

app.post('/api/alerts/test', async (req, res) => {
  const r = await notify({ id: null, name: 'API Monitor' }, 'TEST', 'This is a test alert. Your notification channel works!');
  res.json({ channels: channels(), ...r });
});

app.get('/api/logs', (req, res) => {
  fs.readFile(LOG_FILE, 'utf8', (err, data) => {
    if (err) return res.json([]);
    res.json(data.trim().split('\n').slice(-(Math.min(300, +req.query.limit || 100))).reverse());
  });
});

server.listen(PORT, () => {
  log('INFO', `API Monitor running on http://localhost:${PORT}`);
  const c = channels();
  log('INFO', `Alert channels: dashboard${c.email ? ', email' : ''}${c.telegram ? ', telegram' : ''}${c.webhook ? ', webhook' : ''}`);
});

process.on('SIGINT', () => { db.close(); process.exit(0); });
