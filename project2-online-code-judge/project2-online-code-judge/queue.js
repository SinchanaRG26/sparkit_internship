/**
 * Submission queue. Submissions are rows in SQLite (status QUEUED); a small pool of workers
 * claims them one by one, so a slow or malicious program never blocks the web server and the
 * queue survives a restart.
 */
const { db } = require('./db');
const runner = require('./runner');

const CONCURRENCY = Math.max(1, +process.env.JUDGE_WORKERS || 2);
let running = 0, timer = null, processed = 0;

const claim = db.prepare("UPDATE submissions SET status = 'RUNNING', started_at = ? WHERE id = (SELECT id FROM submissions WHERE status = 'QUEUED' ORDER BY id LIMIT 1) RETURNING id, problem_id, kind, language, code, custom_input");
const finish = db.prepare('UPDATE submissions SET status = ?, passed = ?, total = ?, time_ms = ?, memory_kb = ?, result = ?, finished_at = ? WHERE id = ?');
const problemOf = db.prepare('SELECT id, time_limit_ms, memory_mb FROM problems WHERE id = ?');
const testsOf = db.prepare('SELECT input, expected, is_sample AS sample FROM testcases WHERE problem_id = ? ORDER BY position, id');

async function work(job) {
  try {
    if (job.kind === 'RUN') {
      const r = await runner.runOnce({ language: job.language, code: job.code, input: job.custom_input || '' });
      finish.run(r.status, 0, 0, r.timeMs ?? null, r.memoryKb ?? null, JSON.stringify(r), Date.now(), job.id);
    } else {
      const p = problemOf.get(job.problem_id);
      const r = await runner.judge({ language: job.language, code: job.code, tests: testsOf.all(job.problem_id), timeLimitMs: p.time_limit_ms, memMb: p.memory_mb });
      finish.run(r.status, r.passed, r.total, r.timeMs ?? null, r.memoryKb ?? null, JSON.stringify({ message: r.message || '', results: r.results }), Date.now(), job.id);
    }
  } catch (e) {
    console.error('[queue] job', job.id, 'failed:', e.message);
    finish.run('INTERNAL_ERROR', 0, 0, null, null, JSON.stringify({ message: 'Internal judge error' }), Date.now(), job.id);
  }
}

function tick() {
  while (running < CONCURRENCY) {
    const job = claim.get(Date.now());
    if (!job) return;
    running++;
    work(job).finally(() => { running--; processed++; setImmediate(tick); });
  }
}

function start() {
  // anything left RUNNING by a crash goes back to the queue
  const n = db.prepare("UPDATE submissions SET status = 'QUEUED', started_at = NULL WHERE status = 'RUNNING'").run().changes;
  if (n) console.log(`[queue] re-queued ${n} interrupted submission(s)`);
  timer = setInterval(tick, 300);
  tick();
}
const stop = () => clearInterval(timer);
const stats = () => ({
  queued: db.prepare("SELECT COUNT(*) n FROM submissions WHERE status = 'QUEUED'").get().n,
  running, workers: CONCURRENCY, processed,
});
module.exports = { start, stop, tick, stats };
