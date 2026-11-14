const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { DATA_DIR } = require('./db');

// Signing secret: env var, otherwise generated once and kept in data/secret.key
const SECRET = process.env.JWT_SECRET || (() => {
  const f = path.join(DATA_DIR, 'secret.key');
  try { return fs.readFileSync(f, 'utf8'); } catch { /* first run */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s);
  return s;
})();

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  const a = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sign = u => jwt.sign({ sub: u.id, username: u.username }, SECRET, { expiresIn: '12h' });

/** Attaches req.user when a valid Bearer token is present (does not reject). */
function optionalAuth(req, _res, next) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    try { const p = jwt.verify(h.slice(7), SECRET); req.user = { id: p.sub, username: p.username }; } catch { /* ignore */ }
  }
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in first' });
  next();
}
module.exports = { hashPassword, checkPassword, sign, optionalAuth, requireAuth };
