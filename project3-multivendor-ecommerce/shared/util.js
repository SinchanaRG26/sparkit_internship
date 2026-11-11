/**
 * Small helpers shared by every service: errors, logging, validation, bootstrap.
 */
class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
const bad = (m, d) => new HttpError(400, m, d);

function logger(name) {
  return (level, msg) => console.log(`${new Date().toISOString()} [${name}] [${level}] ${msg}`);
}

function requestLogger(log) {
  return (req, res, next) => {
    const t = Date.now();
    res.on('finish', () => log('INFO', `${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - t}ms rid=${req.headers['x-request-id'] || '-'}`));
    next();
  };
}

function errorHandler(log) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    log('ERROR', err.stack || String(err));
    res.status(500).json({ error: 'Internal server error' });
  };
}

function cleanStr(v, { min = 0, max = 200, field = 'value', required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${field} is required`);
    return '';
  }
  if (typeof v !== 'string') throw bad(`${field} must be text`);
  const s = v.trim();
  if (required && !s) throw bad(`${field} is required`);
  if (s.length < min) throw bad(`${field} must be at least ${min} characters`);
  if (s.length > max) throw bad(`${field} must be at most ${max} characters`);
  return s;
}

function cleanInt(v, { min = 0, max = 1e9, field = 'value' } = {}) {
  const n = Number(v);
  if (v === '' || v === null || !Number.isInteger(n) || n < min || n > max) throw bad(`${field} must be a whole number between ${min} and ${max}`);
  return n;
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Adds 404 + error handler and starts listening on localhost. */
function start({ name, app, log, port }) {
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler(log));
  return app.listen(port, '127.0.0.1', () => log('INFO', `${name} listening on http://127.0.0.1:${port}`));
}

module.exports = { HttpError, bad, logger, requestLogger, errorHandler, cleanStr, cleanInt, clampInt, start };
