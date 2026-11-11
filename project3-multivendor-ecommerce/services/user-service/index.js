/**
 * User service: registration, login (JWT), roles (customer / vendor).
 */
const express = require('express');
const crypto = require('crypto');
const { open } = require('../../shared/db');
const auth = require('../../shared/auth');
const { HttpError, bad, logger, requestLogger, cleanStr, start } = require('../../shared/util');

const log = logger('user-service');
const db = open('users');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('customer','vendor')),
  shop_name     TEXT,
  created_at    INTEGER NOT NULL
);`);

const q = {
  byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  insert: db.prepare('INSERT INTO users (name, email, password_hash, salt, role, shop_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  vendors: db.prepare("SELECT id, shop_name FROM users WHERE role = 'vendor' ORDER BY shop_name"),
};

const hash = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const pub = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, shopName: u.shop_name });

// very small in-memory login throttle: 10 failures / 15 min per ip+email
const attempts = new Map();
function throttle(key) {
  const now = Date.now();
  const a = attempts.get(key);
  if (a && a.reset > now && a.count >= 10) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
}
function fail(key) {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.reset < now) attempts.set(key, { count: 1, reset: now + 15 * 60 * 1000 });
  else a.count++;
}

const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(requestLogger(log));

app.get('/health', (req, res) => res.json({ service: 'user-service', status: 'UP' }));

app.post('/auth/register', (req, res) => {
  const b = req.body || {};
  const name = cleanStr(b.name, { min: 2, max: 60, field: 'Name', required: true });
  const email = cleanStr(b.email, { max: 120, field: 'Email', required: true }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address');
  const password = typeof b.password === 'string' ? b.password : '';
  if (password.length < 8 || password.length > 100) throw bad('Password must be 8 to 100 characters');
  const role = b.role === 'vendor' ? 'vendor' : 'customer';
  const shop = role === 'vendor' ? cleanStr(b.shopName, { min: 2, max: 50, field: 'Shop name', required: true }) : null;
  if (q.byEmail.get(email)) throw new HttpError(409, 'An account with this email already exists');
  const salt = crypto.randomBytes(16).toString('hex');
  const info = q.insert.run(name, email, hash(password, salt), salt, role, shop, Date.now());
  const user = q.byId.get(info.lastInsertRowid);
  log('INFO', `registered ${role} ${email}`);
  res.status(201).json({ token: auth.sign(user), user: pub(user) });
});

app.post('/auth/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const key = `${req.headers['x-forwarded-for'] || req.ip}|${email}`;
  throttle(key);
  const user = q.byEmail.get(email);
  const ok = user && crypto.timingSafeEqual(Buffer.from(hash(password, user.salt), 'hex'), Buffer.from(user.password_hash, 'hex'));
  if (!ok) { fail(key); throw new HttpError(401, 'Incorrect email or password'); }
  attempts.delete(key);
  res.json({ token: auth.sign(user), user: pub(user) });
});

app.get('/auth/me', auth.authenticate, (req, res) => {
  const user = q.byId.get(req.user.id);
  if (!user) throw new HttpError(401, 'Account no longer exists');
  res.json({ user: pub(user) });
});

app.get('/auth/vendors', (req, res) => res.json(q.vendors.all().map(v => ({ id: v.id, shopName: v.shop_name }))));

start({ name: 'user-service', app, log, port: +process.env.PORT || 4001 });
