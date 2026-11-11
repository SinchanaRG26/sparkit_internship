/**
 * JWT helpers. Every service verifies tokens itself (stateless auth), and
 * service-to-service calls use a shared internal key that the gateway never forwards.
 */
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { HttpError } = require('./util');

const SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const INTERNAL_KEY = process.env.INTERNAL_KEY || 'dev-internal-key-change-me';

function sign(user) {
  return jwt.sign(
    { sub: user.id, name: user.name, email: user.email, role: user.role, shop: user.shop_name || null },
    SECRET, { algorithm: 'HS256', expiresIn: '8h' });
}

function authenticate(req, res, next) {
  const h = req.headers.authorization || '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return next(new HttpError(401, 'Please sign in'));
  try {
    const p = jwt.verify(m[1], SECRET, { algorithms: ['HS256'] });
    req.user = { id: p.sub, name: p.name, email: p.email, role: p.role, shop: p.shop };
    next();
  } catch {
    next(new HttpError(401, 'Your session has expired, please sign in again'));
  }
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : next(new HttpError(403, `This action requires the ${roles.join(' / ')} role`));

function requireInternal(req, res, next) {
  const given = Buffer.from(String(req.headers['x-internal-key'] || ''));
  const want = Buffer.from(INTERNAL_KEY);
  if (given.length === want.length && crypto.timingSafeEqual(given, want)) return next();
  next(new HttpError(403, 'Internal endpoint'));
}

module.exports = { sign, authenticate, requireRole, requireInternal, INTERNAL_KEY };
