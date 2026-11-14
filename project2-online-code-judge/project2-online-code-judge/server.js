const express = require('express');
const path = require('path');
const { db, tx } = require('./db');
const { hashPassword, checkPassword, sign, optionalAuth, requireAuth } = require('./auth');
const runner = require('./runner');
const queue = require('./queue');
const problemData = require('./problems');

const PORT = +process.env.PORT || 3000;
const MAX_CODE = 64 * 1024, MAX_INPUT = 64 * 1024;
const MAX_PENDING_PER_USER = 4, MAX_PER_MINUTE = +process.env.SUBMISSIONS_PER_MINUTE || 20;
const FINAL = "('QUEUED','RUNNING')";

/* ------------------------------------------------------------------ seed problems on first run */
function seedProblems() {
  const have = new Set(db.prepare('SELECT slug FROM problems').all().map(r => r.slug));
  const insP = db.prepare('INSERT INTO problems (slug,title,difficulty,statement,input_format,output_format,time_limit_ms,memory_mb,position) VALUES (?,?,?,?,?,?,?,?,?)');
  const insT = db.prepare('INSERT INTO testcases (problem_id,input,expected,is_sample,position) VALUES (?,?,?,?,?)');
  tx(() => {
    for (const p of problemData.build()) {
      if (have.has(p.slug)) continue;
      const id = insP.run(p.slug, p.title, p.difficulty, p.statement, p.input_format, p.output_format, p.time_limit_ms, p.memory_mb, p.position).lastInsertRowid;
      p.tests.forEach((t, i) => insT.run(id, t.input, t.expected, t.sample, i));
    }
  });
  console.log('[seed] loaded', problemData.build().length, 'problems');
}
seedProblems();

/* ------------------------------------------------------------------ app */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use(optionalAuth);
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/* ---- auth */
const attempts = new Map();     // simple login throttle: ip -> [count, resetAt]
app.post('/api/auth/register', wrap((req, res) => {
  const username = str(req.body.username, 30), password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return bad(res, 'Username must be 3-20 letters, digits or underscores');
  if (password.length < 6 || password.length > 100) return bad(res, 'Password must be 6 to 100 characters');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return bad(res, 'That username is taken', 409);
  const id = db.prepare('INSERT INTO users (username,password_hash,created_at) VALUES (?,?,?)').run(username, hashPassword(password), Date.now()).lastInsertRowid;
  const user = { id: Number(id), username };
  res.status(201).json({ token: sign(user), user });
}));
app.post('/api/auth/login', wrap((req, res) => {
  const key = req.ip, now = Date.now(), a = attempts.get(key);
  if (a && a[1] > now && a[0] >= 10) return bad(res, 'Too many attempts. Try again in a minute.', 429);
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(str(req.body.username, 30));
  if (!u || typeof req.body.password !== 'string' || !checkPassword(req.body.password, u.password_hash)) {
    attempts.set(key, [(a && a[1] > now ? a[0] : 0) + 1, now + 60000]);
    return bad(res, 'Wrong username or password', 401);
  }
  attempts.delete(key);
  res.json({ token: sign(u), user: { id: u.id, username: u.username } });
}));
app.get('/api/auth/me', requireAuth, (req, res) => res.json(req.user));

/* ---- meta */
app.get('/api/languages', (_req, res) => res.json({ languages: runner.languages(), sandbox: runner.SANDBOX, warning: runner.sandboxError || null }));
app.get('/api/queue', (_req, res) => res.json({ ...queue.stats(), sandbox: runner.SANDBOX }));
app.get('/api/health', (_req, res) => res.json({ ok: true, ...queue.stats(), problems: db.prepare('SELECT COUNT(*) n FROM problems').get().n }));

/* ---- problems */
app.get('/api/problems', wrap((req, res) => {
  const rows = db.prepare(`
    SELECT p.slug, p.title, p.difficulty, p.time_limit_ms AS timeLimitMs, p.memory_mb AS memoryMb,
      (SELECT COUNT(*) FROM submissions s WHERE s.problem_id = p.id AND s.kind = 'SUBMIT' AND s.status NOT IN ${FINAL}) AS total,
      (SELECT COUNT(*) FROM submissions s WHERE s.problem_id = p.id AND s.kind = 'SUBMIT' AND s.status = 'ACCEPTED') AS accepted,
      (SELECT COUNT(*) FROM submissions s WHERE s.problem_id = p.id AND s.kind = 'SUBMIT' AND s.user_id = ?) AS mine,
      (SELECT COUNT(*) FROM submissions s WHERE s.problem_id = p.id AND s.kind = 'SUBMIT' AND s.user_id = ? AND s.status = 'ACCEPTED') AS mineOk
    FROM problems p ORDER BY p.position`).all(req.user?.id ?? 0, req.user?.id ?? 0);
  res.json(rows.map(r => ({ slug: r.slug, title: r.title, difficulty: r.difficulty, timeLimitMs: r.timeLimitMs, memoryMb: r.memoryMb,
    accepted: r.accepted, total: r.total, status: r.mineOk ? 'solved' : r.mine ? 'attempted' : 'new' })));
}));
app.get('/api/problems/:slug', wrap((req, res) => {
  const p = db.prepare('SELECT * FROM problems WHERE slug = ?').get(req.params.slug);
  if (!p) return bad(res, 'Problem not found', 404);
  const samples = db.prepare('SELECT input, expected FROM testcases WHERE problem_id = ? AND is_sample = 1 ORDER BY position').all(p.id);
  res.json({ slug: p.slug, title: p.title, difficulty: p.difficulty, statement: p.statement, inputFormat: p.input_format, outputFormat: p.output_format,
    timeLimitMs: p.time_limit_ms, memoryMb: p.memory_mb, samples, hiddenTests: db.prepare('SELECT COUNT(*) n FROM testcases WHERE problem_id = ? AND is_sample = 0').get(p.id).n });
}));

/* ---- submissions and runs */
function checkSource(req, res, needInput) {
  const language = str(req.body.language, 20), code = typeof req.body.code === 'string' ? req.body.code : '';
  if (!runner.LANGS[language]) { bad(res, 'Unsupported language'); return null; }
  if (!code.trim()) { bad(res, 'Write some code first'); return null; }
  if (Buffer.byteLength(code) > MAX_CODE) { bad(res, 'Code is too long (64 KB maximum)'); return null; }
  const input = typeof req.body.input === 'string' ? req.body.input : '';
  if (needInput && Buffer.byteLength(input) > MAX_INPUT) { bad(res, 'Input is too long'); return null; }
  const pending = db.prepare(`SELECT COUNT(*) n FROM submissions WHERE user_id = ? AND status IN ${FINAL}`).get(req.user.id).n;
  if (pending >= MAX_PENDING_PER_USER) { bad(res, 'You already have several jobs waiting. Please wait for them to finish.', 429); return null; }
  const recent = db.prepare('SELECT COUNT(*) n FROM submissions WHERE user_id = ? AND created_at > ?').get(req.user.id, Date.now() - 60000).n;
  if (recent >= MAX_PER_MINUTE) { bad(res, 'Slow down: too many submissions in one minute', 429); return null; }
  return { language, code, input };
}
const enqueue = db.prepare('INSERT INTO submissions (user_id,problem_id,kind,language,code,custom_input,status,created_at) VALUES (?,?,?,?,?,?,?,?)');

app.post('/api/submissions', requireAuth, wrap((req, res) => {
  const p = db.prepare('SELECT id FROM problems WHERE slug = ?').get(str(req.body.slug, 80));
  if (!p) return bad(res, 'Problem not found', 404);
  const s = checkSource(req, res, false); if (!s) return;
  const id = Number(enqueue.run(req.user.id, p.id, 'SUBMIT', s.language, s.code, null, 'QUEUED', Date.now()).lastInsertRowid);
  queue.tick();
  res.status(202).json({ id, status: 'QUEUED', queue: queue.stats() });
}));
app.post('/api/run', requireAuth, wrap((req, res) => {
  const s = checkSource(req, res, true); if (!s) return;
  const id = Number(enqueue.run(req.user.id, null, 'RUN', s.language, s.code, s.input, 'QUEUED', Date.now()).lastInsertRowid);
  queue.tick();
  res.status(202).json({ id, status: 'QUEUED' });
}));

const shape = (r, withCode) => {
  const result = r.result ? JSON.parse(r.result) : null;
  return { id: r.id, kind: r.kind, problem: r.slug ? { slug: r.slug, title: r.title } : null, username: r.username, language: r.language, status: r.status,
    passed: r.passed, total: r.total, timeMs: r.time_ms, memoryKb: r.memory_kb, createdAt: r.created_at,
    waitMs: r.started_at ? r.started_at - r.created_at : null, judgeMs: r.finished_at && r.started_at ? r.finished_at - r.started_at : null,
    ...(withCode ? { code: r.code, customInput: r.custom_input, result } : {}) };
};
const SUB_SELECT = 'SELECT s.*, p.slug, p.title, u.username FROM submissions s LEFT JOIN problems p ON p.id = s.problem_id JOIN users u ON u.id = s.user_id';

app.get('/api/submissions', requireAuth, wrap((req, res) => {
  const slug = str(req.query.problem, 80), limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const rows = db.prepare(`${SUB_SELECT} WHERE s.user_id = ? AND s.kind = 'SUBMIT' ${slug ? 'AND p.slug = ?' : ''} ORDER BY s.id DESC LIMIT ${limit}`).all(...(slug ? [req.user.id, slug] : [req.user.id]));
  res.json(rows.map(r => shape(r, false)));
}));
app.get('/api/submissions/:id', requireAuth, wrap((req, res) => {
  const r = db.prepare(`${SUB_SELECT} WHERE s.id = ?`).get(parseInt(req.params.id, 10) || 0);
  if (!r || r.user_id !== req.user.id) return bad(res, 'Submission not found', 404);      // others' code stays private
  res.json(shape(r, true));
}));

/* ---- leaderboard: most problems solved, then least penalty (minutes to first AC + 20 per wrong try) */
app.get('/api/leaderboard', wrap((_req, res) => {
  const rows = db.prepare(`SELECT s.user_id, u.username, s.problem_id, s.status, s.created_at, s.language FROM submissions s JOIN users u ON u.id = s.user_id
    WHERE s.kind = 'SUBMIT' AND s.status NOT IN ('QUEUED','RUNNING','COMPILE_ERROR','REJECTED','INTERNAL_ERROR') ORDER BY s.id`).all();
  const users = new Map();
  for (const r of rows) {
    const u = users.get(r.user_id) || { username: r.username, probs: new Map(), submissions: 0, langs: {} };
    users.set(r.user_id, u); u.submissions++;
    const p = u.probs.get(r.problem_id) || { first: r.created_at, wrong: 0, ac: null };
    u.probs.set(r.problem_id, p);
    if (p.ac === null) { if (r.status === 'ACCEPTED') { p.ac = r.created_at; u.langs[r.language] = (u.langs[r.language] || 0) + 1; } else p.wrong++; }
  }
  const board = [...users.values()].map(u => {
    const solved = [...u.probs.values()].filter(p => p.ac !== null);
    const penalty = solved.reduce((s, p) => s + Math.round((p.ac - p.first) / 60000) + 20 * p.wrong, 0);
    return { username: u.username, solved: solved.length, penalty, submissions: u.submissions, lastAc: solved.length ? Math.max(...solved.map(p => p.ac)) : null,
      favourite: Object.entries(u.langs).sort((a, b) => b[1] - a[1])[0]?.[0] || null };
  }).sort((a, b) => b.solved - a.solved || a.penalty - b.penalty || (a.lastAc ?? 0) - (b.lastAc ?? 0));
  res.json(board.map((r, i) => ({ rank: i + 1, ...r })));
}));

/* ---- static front end + errors */
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (_req, res) => bad(res, 'Not found', 404));
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') return bad(res, 'Request too large', 413);
  if (err.type === 'entity.parse.failed') return bad(res, 'Invalid JSON');
  console.error('[error]', err);
  bad(res, 'Server error', 500);
});

const server = app.listen(PORT, '127.0.0.1', () => {
  queue.start();
  console.log(`\n  JudgeLab running at http://localhost:${PORT}`);
  console.log(`  Sandbox: ${runner.SANDBOX} | languages: ${runner.languages().map(l => l.id).join(', ')} | workers: ${queue.stats().workers}`);
  if (runner.sandboxError) console.log('  WARNING:', runner.sandboxError);
  console.log('  Press Ctrl+C to stop.\n');
});
const shutdown = () => { queue.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
module.exports = { app, server };
