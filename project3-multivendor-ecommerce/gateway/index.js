/**
 * API gateway: the single public entry point.
 *  - serves the storefront (static files)
 *  - routes /api/* to the right microservice
 *  - adds a request id, basic rate limiting, health aggregation
 *  - never exposes the services' /internal endpoints
 */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { logger, requestLogger, errorHandler } = require('../shared/util');

const log = logger('gateway');
const PORT = +process.env.PORT || 4000;
const USER = process.env.USER_URL || 'http://127.0.0.1:4001';
const CATALOG = process.env.CATALOG_URL || 'http://127.0.0.1:4002';
const ORDER = process.env.ORDER_URL || 'http://127.0.0.1:4003';

// first matching prefix wins (more specific prefixes first)
const ROUTES = [
  ['/auth', 'user-service', USER],
  ['/vendor/products', 'catalog-service', CATALOG],
  ['/products', 'catalog-service', CATALOG],
  ['/categories', 'catalog-service', CATALOG],
  ['/cart', 'order-service', ORDER],
  ['/coupons', 'order-service', ORDER],
  ['/checkout', 'order-service', ORDER],
  ['/orders', 'order-service', ORDER],
  ['/vendor/orders', 'order-service', ORDER],
  ['/vendor/items', 'order-service', ORDER],
  ['/vendor/stats', 'order-service', ORDER],
];

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  req.headers['x-request-id'] = crypto.randomBytes(6).toString('hex');
  res.setHeader('X-Request-Id', req.headers['x-request-id']);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use('/api', requestLogger(log));
app.use(express.json({ limit: '50kb' }));

// simple per-IP rate limit: 300 requests / minute
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();
app.use('/api', (req, res, next) => {
  const n = (hits.get(req.ip) || 0) + 1;
  hits.set(req.ip, n);
  if (n > 300) return res.status(429).json({ error: 'Too many requests. Slow down a little.' });
  next();
});

app.get('/api/health', async (req, res) => {
  const targets = [['user-service', USER], ['catalog-service', CATALOG], ['order-service', ORDER]];
  const services = await Promise.all(targets.map(async ([name, url]) => {
    try {
      const r = await fetch(url + '/health', { signal: AbortSignal.timeout(1500) });
      return { name, status: r.ok ? 'UP' : 'DOWN' };
    } catch { return { name, status: 'DOWN' }; }
  }));
  res.json({ gateway: 'UP', services, ok: services.every(s => s.status === 'UP') });
});

app.use('/api', async (req, res, next) => {
  const route = ROUTES.find(([p]) => req.path === p || req.path.startsWith(p + '/'));
  if (!route) return next();
  const [, service, base] = route;
  const headers = { 'x-request-id': req.headers['x-request-id'] };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;   // only whitelisted headers are forwarded
  if (req.headers['x-forwarded-for']) headers['x-forwarded-for'] = req.headers['x-forwarded-for'];
  else headers['x-forwarded-for'] = req.ip;
  const init = { method: req.method, headers, signal: AbortSignal.timeout(15000) };
  if (!['GET', 'HEAD'].includes(req.method) && req.body && Object.keys(req.body).length) {
    init.body = JSON.stringify(req.body);
    headers['content-type'] = 'application/json';
  }
  try {
    const r = await fetch(base + req.originalUrl.replace(/^\/api/, ''), init);
    res.status(r.status);
    for (const h of ['content-type', 'content-disposition']) if (r.headers.get(h)) res.setHeader(h, r.headers.get(h));
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    log('ERROR', `${service} unreachable: ${e.message}`);
    res.status(503).json({ error: `The ${service} is temporarily unavailable. Please try again in a moment.`, service });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use(errorHandler(log));

app.listen(PORT, () => log('INFO', `gateway + storefront on http://localhost:${PORT}`));
