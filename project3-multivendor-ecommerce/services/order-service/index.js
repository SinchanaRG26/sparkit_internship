/**
 * Order service: shopping cart, pricing/coupons, checkout, order tracking,
 * vendor order management + sales statistics, PDF invoices.
 * Talks to the catalog service over HTTP (internal API) to read prices and reserve stock.
 */
const express = require('express');
const crypto = require('crypto');
const { open, tx } = require('../../shared/db');
const auth = require('../../shared/auth');
const { HttpError, bad, logger, requestLogger, cleanStr, cleanInt, clampInt, start } = require('../../shared/util');
const { price, COUPONS } = require('./pricing');
const { renderInvoice } = require('./invoice');

const log = logger('order-service');
const CATALOG_URL = process.env.CATALOG_URL || 'http://127.0.0.1:4002';
const FLOW = ['PLACED', 'CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED'];
const MAX_LINE_QTY = 20;

const db = open('orders');
db.exec(`
CREATE TABLE IF NOT EXISTS carts (
  user_id    INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty        INTEGER NOT NULL CHECK (qty > 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, product_id)
);
CREATE TABLE IF NOT EXISTS orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL,
  customer_name  TEXT NOT NULL,
  customer_email TEXT,
  payment_method TEXT NOT NULL,
  payment_status TEXT NOT NULL,
  transaction_id TEXT,
  coupon_code    TEXT,
  subtotal_paise INTEGER NOT NULL,
  discount_paise INTEGER NOT NULL,
  shipping_paise INTEGER NOT NULL,
  tax_paise      INTEGER NOT NULL,
  total_paise    INTEGER NOT NULL,
  address        TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at);
CREATE TABLE IF NOT EXISTS order_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       INTEGER NOT NULL,
  vendor_id        INTEGER NOT NULL,
  vendor_name      TEXT NOT NULL,
  name             TEXT NOT NULL,
  unit_price_paise INTEGER NOT NULL,
  qty              INTEGER NOT NULL,
  status           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_vendor ON order_items(vendor_id);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE TABLE IF NOT EXISTS order_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id  INTEGER,
  status   TEXT NOT NULL,
  note     TEXT,
  actor    TEXT,
  ts       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id);`);

// ---------- catalog client ----------
async function catalog(path, { method = 'GET', body } = {}) {
  let r;
  try {
    r = await fetch(CATALOG_URL + '/internal' + path, {
      method, signal: AbortSignal.timeout(4000),
      headers: { 'content-type': 'application/json', 'x-internal-key': auth.INTERNAL_KEY },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new HttpError(503, 'The catalog service is unavailable right now. Please try again shortly.');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status === 409 ? 409 : 502, data.error || 'Catalog service error', data.details);
  return data;
}

// ---------- cart ----------
const customerOnly = [auth.authenticate, auth.requireRole('customer')];
const vendorOnly = [auth.authenticate, auth.requireRole('vendor')];

async function buildCart(userId, couponCode) {
  const rows = db.prepare('SELECT product_id, qty FROM carts WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
  const products = rows.length ? await catalog(`/products?ids=${rows.map(r => r.product_id).join(',')}`) : [];
  const byId = new Map(products.map(p => [p.id, p]));
  const items = [];
  for (const r of rows) {
    const p = byId.get(r.product_id);
    if (!p || !p.active) {
      items.push({ productId: r.product_id, name: p?.name || `Product #${r.product_id}`, vendorName: p?.vendorName || '', pricePaise: 0, qty: r.qty, stock: 0, imageUrl: '', category: '', lineTotalPaise: 0, issue: 'No longer available' });
      continue;
    }
    items.push({
      productId: p.id, name: p.name, vendorName: p.vendorName, category: p.category, imageUrl: p.imageUrl,
      pricePaise: p.pricePaise, qty: r.qty, stock: p.stock, lineTotalPaise: p.pricePaise * r.qty,
      issue: p.stock < r.qty ? (p.stock === 0 ? 'Out of stock' : `Only ${p.stock} left`) : null,
    });
  }
  const priced = price(items.filter(i => !i.issue || i.pricePaise > 0), couponCode);
  return { items, count: items.reduce((s, i) => s + i.qty, 0), hasIssues: items.some(i => i.issue), ...priced };
}

const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(requestLogger(log));

app.get('/health', (req, res) => res.json({ service: 'order-service', status: 'UP', orders: db.prepare('SELECT COUNT(*) n FROM orders').get().n }));

app.get('/cart', ...customerOnly, async (req, res) => res.json(await buildCart(req.user.id, req.query.coupon)));

async function checkedProduct(productId) {
  const [p] = await catalog(`/products?ids=${productId}`);
  if (!p || !p.active) throw new HttpError(404, 'This product is no longer available');
  return p;
}

app.post('/cart/items', ...customerOnly, async (req, res) => {
  const productId = cleanInt(req.body?.productId, { min: 1, field: 'productId' });
  const add = cleanInt(req.body?.qty ?? 1, { min: 1, max: MAX_LINE_QTY, field: 'Quantity' });
  const p = await checkedProduct(productId);
  const cur = db.prepare('SELECT qty FROM carts WHERE user_id = ? AND product_id = ?').get(req.user.id, productId)?.qty || 0;
  const qty = cur + add;
  if (p.stock <= 0) throw new HttpError(409, `${p.name} is out of stock`);
  if (qty > p.stock) throw new HttpError(409, `Only ${p.stock} of ${p.name} available (you already have ${cur} in your cart)`);
  if (qty > MAX_LINE_QTY) throw new HttpError(409, `You can buy at most ${MAX_LINE_QTY} of one product per order`);
  db.prepare(`INSERT INTO carts (user_id, product_id, qty, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(user_id, product_id) DO UPDATE SET qty = excluded.qty, updated_at = excluded.updated_at`)
    .run(req.user.id, productId, qty, Date.now());
  res.status(201).json(await buildCart(req.user.id, req.query.coupon));
});

app.put('/cart/items/:productId', ...customerOnly, async (req, res) => {
  const productId = cleanInt(req.params.productId, { min: 1, field: 'productId' });
  const qty = cleanInt(req.body?.qty, { min: 0, max: MAX_LINE_QTY, field: 'Quantity' });
  if (qty === 0) db.prepare('DELETE FROM carts WHERE user_id = ? AND product_id = ?').run(req.user.id, productId);
  else {
    const p = await checkedProduct(productId);
    if (qty > p.stock) throw new HttpError(409, `Only ${p.stock} of ${p.name} available`);
    db.prepare(`INSERT INTO carts (user_id, product_id, qty, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id, product_id) DO UPDATE SET qty = excluded.qty, updated_at = excluded.updated_at`)
      .run(req.user.id, productId, qty, Date.now());
  }
  res.json(await buildCart(req.user.id, req.query.coupon));
});

app.delete('/cart/items/:productId', ...customerOnly, async (req, res) => {
  db.prepare('DELETE FROM carts WHERE user_id = ? AND product_id = ?').run(req.user.id, clampInt(req.params.productId, 0, 0, 1e12));
  res.json(await buildCart(req.user.id, req.query.coupon));
});

app.delete('/cart', ...customerOnly, async (req, res) => {
  db.prepare('DELETE FROM carts WHERE user_id = ?').run(req.user.id);
  res.json(await buildCart(req.user.id));
});

app.get('/coupons', (req, res) => res.json(Object.entries(COUPONS).map(([code, c]) => ({ code, label: c.label }))));

// ---------- orders ----------
const orderStatus = items => {
  const active = items.filter(i => i.status !== 'CANCELLED');
  if (!active.length) return 'CANCELLED';
  return FLOW[Math.min(...active.map(i => FLOW.indexOf(i.status)))];
};

function loadOrder(id) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!o) return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(id).map(i => ({
    id: i.id, productId: i.product_id, vendorId: i.vendor_id, vendorName: i.vendor_name, name: i.name,
    unitPricePaise: i.unit_price_paise, qty: i.qty, lineTotalPaise: i.unit_price_paise * i.qty, status: i.status,
  }));
  const events = db.prepare('SELECT id, item_id, status, note, actor, ts FROM order_events WHERE order_id = ? ORDER BY ts, id').all(id)
    .map(e => ({ id: e.id, itemId: e.item_id, status: e.status, note: e.note, actor: e.actor, ts: e.ts }));
  return {
    id: o.id, invoiceNo: `INV-${new Date(o.created_at).getFullYear()}-${String(o.id).padStart(5, '0')}`,
    userId: o.user_id, customerName: o.customer_name, status: orderStatus(items),
    paymentMethod: o.payment_method, paymentStatus: o.payment_status, transactionId: o.transaction_id, couponCode: o.coupon_code,
    subtotalPaise: o.subtotal_paise, discountPaise: o.discount_paise, shippingPaise: o.shipping_paise, taxPaise: o.tax_paise, totalPaise: o.total_paise,
    address: JSON.parse(o.address), createdAt: o.created_at, items, events,
  };
}

function event(orderId, itemId, status, note, actor) {
  db.prepare('INSERT INTO order_events (order_id, item_id, status, note, actor, ts) VALUES (?, ?, ?, ?, ?, ?)').run(orderId, itemId, status, note, actor, Date.now());
}

function syncPayment(orderId) {
  const o = db.prepare('SELECT payment_method, payment_status FROM orders WHERE id = ?').get(orderId);
  const items = db.prepare('SELECT status FROM order_items WHERE order_id = ?').all(orderId);
  const active = items.filter(i => i.status !== 'CANCELLED');
  let next = o.payment_status;
  if (!active.length) next = o.payment_status === 'PAID' ? 'REFUNDED' : 'CANCELLED';
  else if (o.payment_method === 'COD' && active.every(i => i.status === 'DELIVERED')) next = 'PAID';
  if (next !== o.payment_status) db.prepare('UPDATE orders SET payment_status = ? WHERE id = ?').run(next, orderId);
}

/** Cancels the given order items (only while PLACED/CONFIRMED) and returns stock to the catalog. */
async function cancelItems(orderId, predicate, actor, note) {
  const items = db.prepare("SELECT * FROM order_items WHERE order_id = ? AND status IN ('PLACED','CONFIRMED')").all(orderId).filter(predicate);
  if (!items.length) return [];
  await catalog('/release', { method: 'POST', body: { items: items.map(i => ({ productId: i.product_id, qty: i.qty })) } });
  tx(db, () => {
    for (const i of items) {
      db.prepare("UPDATE order_items SET status = 'CANCELLED' WHERE id = ?").run(i.id);
      event(orderId, i.id, 'CANCELLED', note, actor);
    }
    syncPayment(orderId);
  });
  return items;
}

function readAddress(a) {
  if (!a || typeof a !== 'object') throw bad('Delivery address is required');
  const out = {
    name: cleanStr(a.name, { min: 2, max: 60, field: 'Full name', required: true }),
    phone: cleanStr(a.phone, { min: 7, max: 15, field: 'Phone', required: true }),
    line1: cleanStr(a.line1, { min: 5, max: 150, field: 'Address', required: true }),
    city: cleanStr(a.city, { min: 2, max: 50, field: 'City', required: true }),
    state: cleanStr(a.state, { min: 2, max: 50, field: 'State', required: true }),
    pin: cleanStr(a.pin, { min: 6, max: 6, field: 'PIN code', required: true }),
  };
  if (!/^[0-9+\- ]{7,15}$/.test(out.phone)) throw bad('Enter a valid phone number');
  if (!/^[0-9]{6}$/.test(out.pin)) throw bad('PIN code must be 6 digits');
  return out;
}

app.post('/checkout', ...customerOnly, async (req, res) => {
  const b = req.body || {};
  const address = readAddress(b.address);
  const method = ['COD', 'CARD_TEST', 'UPI_TEST'].includes(b.paymentMethod) ? b.paymentMethod : null;
  if (!method) throw bad('Choose a payment method');
  const rows = db.prepare('SELECT product_id, qty FROM carts WHERE user_id = ?').all(req.user.id);
  if (!rows.length) throw bad('Your cart is empty');

  // 1) reserve stock atomically in the catalog service (all lines or nothing)
  const reserved = (await catalog('/reserve', { method: 'POST', body: { items: rows.map(r => ({ productId: r.product_id, qty: r.qty })) } })).items;
  const release = () => catalog('/release', { method: 'POST', body: { items: reserved.map(i => ({ productId: i.productId, qty: i.qty })) } }).catch(e => log('ERROR', 'stock release failed: ' + e.message));

  try {
    // 2) price from the authoritative snapshot returned by the catalog (never trust client prices)
    const priced = price(reserved, b.coupon);
    if (b.coupon && priced.couponError) throw bad(priced.couponError);
    const paid = method !== 'COD';
    const txn = paid ? 'TXN' + crypto.randomBytes(5).toString('hex').toUpperCase() : null;

    // 3) persist the order, its items and first tracking event; empty the cart
    const orderId = tx(db, () => {
      const info = db.prepare(`INSERT INTO orders (user_id, customer_name, customer_email, payment_method, payment_status, transaction_id, coupon_code,
          subtotal_paise, discount_paise, shipping_paise, tax_paise, total_paise, address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.user.id, req.user.name, req.user.email || '', method, paid ? 'PAID' : 'PENDING', txn, priced.coupon?.code || null,
          priced.subtotalPaise, priced.discountPaise, priced.shippingPaise, priced.taxPaise, priced.totalPaise, JSON.stringify(address), Date.now());
      const oid = Number(info.lastInsertRowid);
      for (const i of reserved) {
        const it = db.prepare('INSERT INTO order_items (order_id, product_id, vendor_id, vendor_name, name, unit_price_paise, qty, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(oid, i.productId, i.vendorId, i.vendorName, i.name, i.pricePaise, i.qty, 'PLACED');
        event(oid, Number(it.lastInsertRowid), 'PLACED', `${i.qty} x ${i.name}`, 'customer');
      }
      db.prepare('DELETE FROM carts WHERE user_id = ?').run(req.user.id);
      return oid;
    });
    log('INFO', `order #${orderId} placed by user ${req.user.id} total=${priced.totalPaise}`);
    res.status(201).json(loadOrder(orderId));
  } catch (e) {
    await release();
    throw e;
  }
});

const summary = o => ({
  id: o.id, createdAt: o.createdAt, status: o.status, totalPaise: o.totalPaise, paymentMethod: o.paymentMethod, paymentStatus: o.paymentStatus,
  items: o.items.map(i => ({ name: i.name, qty: i.qty, status: i.status, vendorName: i.vendorName })),
});

app.get('/orders', ...customerOnly, (req, res) => {
  const ids = db.prepare('SELECT id FROM orders WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100').all(req.user.id);
  res.json(ids.map(r => summary(loadOrder(r.id))));
});

function ownOrder(req) {
  const o = loadOrder(clampInt(req.params.id, 0, 0, 1e12));
  if (!o || o.userId !== req.user.id) throw new HttpError(404, 'Order not found');
  return o;
}

app.get('/orders/:id', ...customerOnly, (req, res) => res.json(ownOrder(req)));

app.post('/orders/:id/cancel', ...customerOnly, async (req, res) => {
  const o = ownOrder(req);
  const done = await cancelItems(o.id, () => true, 'customer', 'Cancelled by customer');
  if (!done.length) throw new HttpError(409, 'This order can no longer be cancelled (it has already been packed or shipped)');
  res.json(loadOrder(o.id));
});

app.get('/orders/:id/invoice', ...customerOnly, (req, res) => {
  const o = ownOrder(req);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${o.invoiceNo}.pdf"`);
  renderInvoice(o, res);
});

// ---------- vendor ----------
app.get('/vendor/orders', ...vendorOnly, (req, res) => {
  const rows = db.prepare(`SELECT oi.*, o.created_at, o.customer_name, o.address, o.payment_method, o.payment_status
                           FROM order_items oi JOIN orders o ON o.id = oi.order_id
                           WHERE oi.vendor_id = ? ORDER BY o.created_at DESC, oi.id DESC LIMIT 200`).all(req.user.id);
  res.json(rows.map(r => ({
    itemId: r.id, orderId: r.order_id, productId: r.product_id, name: r.name, qty: r.qty, unitPricePaise: r.unit_price_paise,
    lineTotalPaise: r.unit_price_paise * r.qty, status: r.status, createdAt: r.created_at, customerName: r.customer_name,
    address: JSON.parse(r.address), paymentMethod: r.payment_method, paymentStatus: r.payment_status,
    next: FLOW[FLOW.indexOf(r.status) + 1] || null, canCancel: ['PLACED', 'CONFIRMED'].includes(r.status),
  })));
});

app.put('/vendor/items/:id/status', ...vendorOnly, async (req, res) => {
  const item = db.prepare('SELECT * FROM order_items WHERE id = ?').get(clampInt(req.params.id, 0, 0, 1e12));
  if (!item) throw new HttpError(404, 'Order item not found');
  if (item.vendor_id !== req.user.id) throw new HttpError(403, 'This item belongs to another vendor');
  const target = String(req.body?.status || '').toUpperCase();

  if (target === 'CANCELLED') {
    const done = await cancelItems(item.order_id, i => i.id === item.id, 'vendor', `Cancelled by ${req.user.shop || 'vendor'}`);
    if (!done.length) throw new HttpError(409, 'This item can no longer be cancelled');
  } else {
    const from = FLOW.indexOf(item.status);
    if (item.status === 'CANCELLED' || from === -1) throw new HttpError(409, 'This item is cancelled');
    if (FLOW.indexOf(target) !== from + 1) throw new HttpError(409, `Next valid status is ${FLOW[from + 1] || 'none (already delivered)'}`);
    tx(db, () => {
      db.prepare('UPDATE order_items SET status = ? WHERE id = ?').run(target, item.id);
      event(item.order_id, item.id, target, `${item.name} marked ${target.toLowerCase()}`, req.user.shop || 'vendor');
      syncPayment(item.order_id);
    });
  }
  const upd = db.prepare('SELECT status FROM order_items WHERE id = ?').get(item.id);
  res.json({ itemId: item.id, status: upd.status });
});

app.get('/vendor/stats', ...vendorOnly, (req, res) => {
  const v = req.user.id;
  const totals = db.prepare("SELECT COUNT(DISTINCT order_id) AS orders, COALESCE(SUM(qty),0) AS units, COALESCE(SUM(qty*unit_price_paise),0) AS revenue FROM order_items WHERE vendor_id = ? AND status != 'CANCELLED'").get(v);
  const statusCounts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM order_items WHERE vendor_id = ? GROUP BY status').all(v).map(r => [r.status, r.n]));
  const top = db.prepare("SELECT name, SUM(qty) AS units, SUM(qty*unit_price_paise) AS revenue FROM order_items WHERE vendor_id = ? AND status != 'CANCELLED' GROUP BY product_id ORDER BY revenue DESC LIMIT 5").all(v);
  const rows = db.prepare(`SELECT strftime('%Y-%m-%d', o.created_at/1000, 'unixepoch', 'localtime') AS day, SUM(oi.qty*oi.unit_price_paise) AS revenue, COUNT(DISTINCT o.id) AS orders
                           FROM order_items oi JOIN orders o ON o.id = oi.order_id
                           WHERE oi.vendor_id = ? AND oi.status != 'CANCELLED' AND o.created_at >= ? GROUP BY day`).all(v, Date.now() - 8 * 864e5);
  const byDay = new Map(rows.map(r => [r.day, r]));
  const pad = n => String(n).padStart(2, '0');
  const daily = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    daily.push({ day: key, revenuePaise: byDay.get(key)?.revenue || 0, orders: byDay.get(key)?.orders || 0 });
  }
  res.json({ ordersCount: totals.orders, unitsSold: totals.units, revenuePaise: totals.revenue, statusCounts, topProducts: top.map(t => ({ name: t.name, units: t.units, revenuePaise: t.revenue })), daily });
});

start({ name: 'order-service', app, log, port: +process.env.PORT || 4003 });
