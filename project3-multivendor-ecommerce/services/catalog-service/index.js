/**
 * Catalog service: products, search / filtering / sorting / pagination,
 * vendor product management and internal stock reservation for the order service.
 * All money is stored as integer paise (1 rupee = 100 paise) to avoid float errors.
 */
const express = require('express');
const { open, tx } = require('../../shared/db');
const auth = require('../../shared/auth');
const { HttpError, bad, logger, requestLogger, cleanStr, cleanInt, clampInt, start } = require('../../shared/util');

const log = logger('catalog-service');
const db = open('catalog');
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id   INTEGER NOT NULL,
  vendor_name TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL,
  price_paise INTEGER NOT NULL CHECK (price_paise > 0),
  stock       INTEGER NOT NULL CHECK (stock >= 0),
  image_url   TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_vendor ON products(vendor_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category, active);`);

const map = r => r && ({
  id: r.id, vendorId: r.vendor_id, vendorName: r.vendor_name, name: r.name, description: r.description,
  category: r.category, pricePaise: r.price_paise, stock: r.stock, imageUrl: r.image_url,
  active: !!r.active, createdAt: r.created_at,
});

const SORTS = {
  newest: 'created_at DESC, id DESC', price_asc: 'price_paise ASC, id ASC', price_desc: 'price_paise DESC, id ASC',
  name: 'name COLLATE NOCASE ASC', stock: 'stock DESC, id ASC',
};

function where(query, skip = {}) {
  const w = ['active = 1'], p = [];
  const search = String(query.search || '').replace(/[%_\\]/g, ' ').trim().slice(0, 60);
  if (search) { w.push('(name LIKE ? OR description LIKE ? OR category LIKE ? OR vendor_name LIKE ?)'); const s = `%${search}%`; p.push(s, s, s, s); }
  if (!skip.category && query.category) { w.push('category = ?'); p.push(String(query.category)); }
  if (!skip.vendor && query.vendor) { w.push('vendor_id = ?'); p.push(clampInt(query.vendor, 0, 0, 1e9)); }
  const min = Number(query.minPrice), max = Number(query.maxPrice);
  if (query.minPrice !== undefined && query.minPrice !== '' && Number.isFinite(min) && min >= 0) { w.push('price_paise >= ?'); p.push(Math.round(min * 100)); }
  if (query.maxPrice !== undefined && query.maxPrice !== '' && Number.isFinite(max) && max > 0) { w.push('price_paise <= ?'); p.push(Math.round(max * 100)); }
  if (query.inStock === '1' || query.inStock === 'true') w.push('stock > 0');
  return { sql: w.join(' AND '), p };
}

function readProduct(body, partial) {
  const out = {};
  const need = !partial;
  if (need || body.name !== undefined) out.name = cleanStr(body.name, { min: 2, max: 120, field: 'Product name', required: true });
  if (body.description !== undefined || need) out.description = cleanStr(body.description, { max: 1000, field: 'Description' });
  if (need || body.category !== undefined) out.category = cleanStr(body.category, { min: 2, max: 40, field: 'Category', required: true });
  if (need || body.pricePaise !== undefined) out.pricePaise = cleanInt(body.pricePaise, { min: 100, max: 1e9, field: 'Price (paise)' });
  if (need || body.stock !== undefined) out.stock = cleanInt(body.stock, { min: 0, max: 100000, field: 'Stock' });
  if (body.imageUrl !== undefined) {
    const u = cleanStr(body.imageUrl, { max: 500, field: 'Image URL' });
    if (u && !/^https?:\/\/[^\s]+$/i.test(u)) throw bad('Image URL must start with http:// or https://');
    out.imageUrl = u;
  }
  return out;
}

const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(requestLogger(log));

app.get('/health', (req, res) => res.json({ service: 'catalog-service', status: 'UP', products: db.prepare('SELECT COUNT(*) n FROM products WHERE active = 1').get().n }));

// ---------- public catalogue ----------
app.get('/products', (req, res) => {
  const page = clampInt(req.query.page, 1, 1, 10000);
  const limit = clampInt(req.query.limit, 12, 1, 48);
  const order = SORTS[req.query.sort] || SORTS.newest;
  const { sql, p } = where(req.query);
  const total = db.prepare(`SELECT COUNT(*) n FROM products WHERE ${sql}`).get(...p).n;
  const items = db.prepare(`SELECT * FROM products WHERE ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...p, limit, (page - 1) * limit).map(map);
  const fc = where(req.query, { category: true });
  const fv = where(req.query, { vendor: true });
  const categories = db.prepare(`SELECT category AS name, COUNT(*) AS count FROM products WHERE ${fc.sql} GROUP BY category ORDER BY count DESC, name`).all(...fc.p);
  const vendors = db.prepare(`SELECT vendor_id AS id, vendor_name AS name, COUNT(*) AS count FROM products WHERE ${fv.sql} GROUP BY vendor_id ORDER BY name`).all(...fv.p);
  res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)), facets: { categories, vendors } });
});

app.get('/products/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(clampInt(req.params.id, 0, 0, 1e12));
  if (!r) throw new HttpError(404, 'Product not found');
  res.json(map(r));
});

app.get('/categories', (req, res) =>
  res.json(db.prepare('SELECT category AS name, COUNT(*) AS count FROM products WHERE active = 1 GROUP BY category ORDER BY count DESC').all()));

// ---------- vendor management ----------
const vendorOnly = [auth.authenticate, auth.requireRole('vendor')];

app.get('/vendor/products', ...vendorOnly, (req, res) =>
  res.json(db.prepare('SELECT * FROM products WHERE vendor_id = ? AND active = 1 ORDER BY id DESC').all(req.user.id).map(map)));

app.post('/products', ...vendorOnly, (req, res) => {
  const p = readProduct(req.body || {}, false);
  const info = db.prepare(`INSERT INTO products (vendor_id, vendor_name, name, description, category, price_paise, stock, image_url, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, req.user.shop || req.user.name, p.name, p.description, p.category, p.pricePaise, p.stock, p.imageUrl || '', Date.now());
  log('INFO', `vendor ${req.user.id} created product ${info.lastInsertRowid}`);
  res.status(201).json(map(db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid)));
});

function ownProduct(req) {
  const r = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(clampInt(req.params.id, 0, 0, 1e12));
  if (!r) throw new HttpError(404, 'Product not found');
  if (r.vendor_id !== req.user.id) throw new HttpError(403, 'You can only change your own products');
  return r;
}

app.put('/products/:id', ...vendorOnly, (req, res) => {
  const cur = ownProduct(req);
  const p = readProduct(req.body || {}, true);
  const m = {
    name: p.name ?? cur.name, description: p.description ?? cur.description, category: p.category ?? cur.category,
    price: p.pricePaise ?? cur.price_paise, stock: p.stock ?? cur.stock, image: p.imageUrl ?? cur.image_url,
  };
  db.prepare('UPDATE products SET name=?, description=?, category=?, price_paise=?, stock=?, image_url=? WHERE id=?')
    .run(m.name, m.description, m.category, m.price, m.stock, m.image, cur.id);
  res.json(map(db.prepare('SELECT * FROM products WHERE id = ?').get(cur.id)));
});

app.delete('/products/:id', ...vendorOnly, (req, res) => {
  const cur = ownProduct(req);
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(cur.id); // soft delete keeps order history valid
  res.json({ ok: true });
});

// ---------- internal API (order service only; not exposed by the gateway) ----------
const internal = express.Router();
internal.use(auth.requireInternal);

internal.get('/products', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 100);
  if (!ids.length) return res.json([]);
  res.json(db.prepare(`SELECT * FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(map));
});

// Atomically checks stock for every line and decrements it, or changes nothing.
internal.post('/reserve', (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length || items.length > 50) throw bad('items required');
  const result = tx(db, () => {
    const lines = [], problems = [];
    for (const it of items) {
      const id = cleanInt(it.productId, { min: 1, field: 'productId' });
      const qty = cleanInt(it.qty, { min: 1, max: 100, field: 'qty' });
      const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      if (!p || !p.active) problems.push({ productId: id, name: p?.name || `#${id}`, reason: 'no longer available', available: 0 });
      else if (p.stock < qty) problems.push({ productId: id, name: p.name, reason: 'not enough stock', available: p.stock });
      else lines.push({ p, qty });
    }
    if (problems.length) throw new HttpError(409, 'Some items are unavailable', problems);
    for (const { p, qty } of lines) db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, p.id);
    return lines.map(({ p, qty }) => ({ productId: p.id, name: p.name, vendorId: p.vendor_id, vendorName: p.vendor_name, pricePaise: p.price_paise, qty }));
  });
  log('INFO', `reserved stock for ${result.length} line(s)`);
  res.json({ items: result });
});

internal.post('/release', (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  tx(db, () => {
    for (const it of items) {
      db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?')
        .run(cleanInt(it.qty, { min: 1, max: 100, field: 'qty' }), cleanInt(it.productId, { min: 1, field: 'productId' }));
    }
  });
  log('INFO', `released stock for ${items.length} line(s)`);
  res.json({ ok: true });
});
app.use('/internal', internal);

start({ name: 'catalog-service', app, log, port: +process.env.PORT || 4002 });
