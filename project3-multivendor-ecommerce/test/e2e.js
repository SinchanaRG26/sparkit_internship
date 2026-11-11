/**
 * End-to-end test: starts all services on temporary databases and exercises the platform
 * through the gateway (register/login, vendor products, filtering, cart, coupons, checkout,
 * stock handling, order tracking, cancellation, invoices, security checks).
 *   npm test
 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-test-'));
const P = { user: 5101, catalog: 5102, order: 5103, gw: 5100 };
const BASE = `http://127.0.0.1:${P.gw}/api`;
const env = {
  ...process.env, DATA_DIR: dataDir,
  USER_URL: `http://127.0.0.1:${P.user}`, CATALOG_URL: `http://127.0.0.1:${P.catalog}`, ORDER_URL: `http://127.0.0.1:${P.order}`,
};
const kids = [
  ['services/user-service/index.js', P.user], ['services/catalog-service/index.js', P.catalog],
  ['services/order-service/index.js', P.order], ['gateway/index.js', P.gw],
].map(([f, port]) => spawn(process.execPath, ['--no-warnings', path.join(root, f)], { env: { ...env, PORT: String(port) }, stdio: 'ignore' }));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`); }
}
async function call(p, { method = 'GET', body, token, raw } = {}) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (raw) return r;
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const stop = () => { kids.forEach(k => k.kill()); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } };

(async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await (await fetch(BASE + '/health')).json()).ok) break; } catch { /* wait */ }
    await new Promise(r => setTimeout(r, 250));
  }
  const addr = { name: 'Test User', phone: '9999999999', line1: '221B Baker Street', city: 'Pune', state: 'Maharashtra', pin: '411001' };

  console.log('\nAuth');
  const reg = await call('/auth/register', { method: 'POST', body: { name: 'Alice Customer', email: 'alice@test.dev', password: 'secret123' } });
  check('customer registers', reg.status === 201 && reg.data.user.role === 'customer');
  check('duplicate email rejected (409)', (await call('/auth/register', { method: 'POST', body: { name: 'Alice', email: 'ALICE@test.dev', password: 'secret123' } })).status === 409);
  check('weak password rejected (400)', (await call('/auth/register', { method: 'POST', body: { name: 'Bob Test', email: 'bob@test.dev', password: 'short' } })).status === 400);
  check('wrong password rejected (401)', (await call('/auth/login', { method: 'POST', body: { email: 'alice@test.dev', password: 'nope-nope' } })).status === 401);
  const alice = (await call('/auth/login', { method: 'POST', body: { email: 'alice@test.dev', password: 'secret123' } })).data;
  check('login returns a token', !!alice.token);
  check('/auth/me works with token', (await call('/auth/me', { token: alice.token })).data.user.email === 'alice@test.dev');
  check('/auth/me without token is 401', (await call('/auth/me')).status === 401);
  check('tampered token is 401', (await call('/auth/me', { token: alice.token.slice(0, -3) + 'abc' })).status === 401);
  const v1 = (await call('/auth/register', { method: 'POST', body: { name: 'Vera Vendor', email: 'v1@test.dev', password: 'secret123', role: 'vendor', shopName: 'Vera Store' } })).data;
  const v2 = (await call('/auth/register', { method: 'POST', body: { name: 'Vik Vendor', email: 'v2@test.dev', password: 'secret123', role: 'vendor', shopName: 'Vik Shop' } })).data;
  check('vendor needs shop name', (await call('/auth/register', { method: 'POST', body: { name: 'No Shop', email: 'ns@test.dev', password: 'secret123', role: 'vendor' } })).status === 400);

  console.log('\nVendor products');
  const mk = (token, name, category, rupees, stock) => call('/products', { method: 'POST', token, body: { name, category, pricePaise: rupees * 100, stock, description: name + ' description' } });
  const pA = (await mk(v1.token, 'Alpha Phone', 'Electronics', 500, 10)).data;
  const pB = (await mk(v1.token, 'Beta Shirt', 'Fashion', 300, 5)).data;
  const pC = (await mk(v2.token, 'Gamma Lamp', 'Home', 1200, 2)).data;
  const pD = (await mk(v2.token, 'Delta Book', 'Books', 150, 50)).data;
  check('vendor creates products', pA.id && pB.id && pC.id && pD.id);
  check('product records vendor shop name', pA.vendorName === 'Vera Store');
  check('customer cannot create products (403)', (await mk(alice.token, 'X Thing', 'Fashion', 100, 1)).status === 403);
  check('anonymous cannot create products (401)', (await mk(undefined, 'X Thing', 'Fashion', 100, 1)).status === 401);
  check('invalid price rejected (400)', (await call('/products', { method: 'POST', token: v1.token, body: { name: 'Bad', category: 'Fashion', pricePaise: -5, stock: 1 } })).status === 400);
  check('other vendor cannot edit product (403)', (await call(`/products/${pA.id}`, { method: 'PUT', token: v2.token, body: { stock: 999 } })).status === 403);
  const edited = await call(`/products/${pA.id}`, { method: 'PUT', token: v1.token, body: { pricePaise: 55000 } });
  check('owner can edit product', edited.data.pricePaise === 55000);
  await call(`/products/${pA.id}`, { method: 'PUT', token: v1.token, body: { pricePaise: 50000 } });
  check("vendor sees only own products", (await call('/vendor/products', { token: v1.token })).data.length === 2);

  console.log('\nListing + filtering');
  let r = (await call('/products')).data;
  check('lists all 4 products', r.total === 4 && r.items.length === 4);
  check('category filter', (await call('/products?category=Fashion')).data.total === 1);
  check('vendor filter', (await call(`/products?vendor=${v2.user.id}`)).data.total === 2);
  check('search filter', (await call('/products?search=lamp')).data.items[0]?.name === 'Gamma Lamp');
  check('price range filter', (await call('/products?minPrice=200&maxPrice=600')).data.total === 2);
  check('sort price ascending', (await call('/products?sort=price_asc')).data.items[0].name === 'Delta Book');
  check('sort price descending', (await call('/products?sort=price_desc')).data.items[0].name === 'Gamma Lamp');
  check('pagination', (await call('/products?limit=2&page=2')).data.items.length === 2);
  check('facets include category counts', r.facets.categories.length === 4);
  check('SQL-injection-style search is harmless', (await call("/products?search=' OR 1=1 --")).status === 200);

  console.log('\nCart + pricing');
  const A = alice.token;
  check('vendor has no cart (403)', (await call('/cart', { token: v1.token })).status === 403);
  check('empty cart', (await call('/cart', { token: A })).data.count === 0);
  let cart = (await call('/cart/items', { method: 'POST', token: A, body: { productId: pA.id, qty: 2 } })).data;
  check('add to cart', cart.count === 2 && cart.subtotalPaise === 100000);
  cart = (await call('/cart/items', { method: 'POST', token: A, body: { productId: pA.id, qty: 1 } })).data;
  check('adding again increases quantity', cart.items[0].qty === 3);
  check('cannot exceed stock (409)', (await call('/cart/items', { method: 'POST', token: A, body: { productId: pC.id, qty: 3 } })).status === 409);
  await call('/cart/items', { method: 'POST', token: A, body: { productId: pB.id, qty: 1 } });
  cart = (await call(`/cart/items/${pA.id}`, { method: 'PUT', token: A, body: { qty: 1 } })).data;
  check('update quantity', cart.items.find(i => i.productId === pA.id).qty === 1);
  cart = (await call('/cart?coupon=WELCOME10', { token: A })).data;
  check('subtotal 500+300 = Rs.800', cart.subtotalPaise === 80000);
  check('WELCOME10 gives 10% off', cart.discountPaise === 8000 && cart.coupon.code === 'WELCOME10');
  check('GST 18% on discounted amount', cart.taxPaise === Math.round(72000 * 0.18));
  check('shipping charged below Rs.999', cart.shippingPaise === 4900);
  check('total is correct', cart.totalPaise === 72000 + 4900 + cart.taxPaise);
  cart = (await call('/cart?coupon=NOPE', { token: A })).data;
  check('invalid coupon reported, not applied', cart.couponError && cart.discountPaise === 0);
  cart = (await call('/cart?coupon=FREESHIP', { token: A })).data;
  check('FREESHIP removes shipping', cart.shippingPaise === 0);
  await call('/cart/items', { method: 'POST', token: A, body: { productId: pD.id, qty: 5 } });
  cart = (await call('/cart', { token: A })).data;
  check('free shipping over Rs.999', cart.subtotalPaise === 80000 + 75000 && cart.shippingPaise === 0);

  console.log('\nCheckout');
  check('invalid address rejected (400)', (await call('/checkout', { method: 'POST', token: A, body: { address: { ...addr, pin: '12' }, paymentMethod: 'COD' } })).status === 400);
  check('invalid coupon at checkout rejected (400)', (await call('/checkout', { method: 'POST', token: A, body: { address: addr, paymentMethod: 'COD', coupon: 'NOPE' } })).status === 400);
  const stockAfterFail = (await call(`/products/${pB.id}`)).data.stock;
  check('failed checkout leaves stock untouched', stockAfterFail === 5, stockAfterFail);
  const order = (await call('/checkout', { method: 'POST', token: A, body: { address: addr, paymentMethod: 'UPI_TEST', coupon: 'WELCOME10' } }));
  check('checkout creates order (201)', order.status === 201, order.data);
  const o = order.data;
  check('order spans two vendors', new Set(o.items.map(i => i.vendorId)).size === 2);
  check('server-side price used', o.subtotalPaise === 155000 && o.discountPaise === 15500);
  check('test payment marked PAID with reference', o.paymentStatus === 'PAID' && /^TXN/.test(o.transactionId));
  check('all items start as PLACED', o.items.every(i => i.status === 'PLACED') && o.status === 'PLACED');
  check('cart emptied after checkout', (await call('/cart', { token: A })).data.count === 0);
  check('stock decremented', (await call(`/products/${pA.id}`)).data.stock === 9 && (await call(`/products/${pB.id}`)).data.stock === 4);
  check('empty cart cannot be checked out (400)', (await call('/checkout', { method: 'POST', token: A, body: { address: addr, paymentMethod: 'COD' } })).status === 400);

  console.log('\nStock race / insufficient stock');
  const bob = (await call('/auth/register', { method: 'POST', body: { name: 'Bob Buyer', email: 'bob@test.dev', password: 'secret123' } })).data;
  await call('/cart/items', { method: 'POST', token: A, body: { productId: pC.id, qty: 2 } });   // alice puts last 2 lamps in cart
  await call('/cart/items', { method: 'POST', token: bob.token, body: { productId: pC.id, qty: 2 } });
  const first = await call('/checkout', { method: 'POST', token: bob.token, body: { address: addr, paymentMethod: 'COD' } });
  const second = await call('/checkout', { method: 'POST', token: A, body: { address: addr, paymentMethod: 'COD' } });
  check('first buyer gets the last lamps', first.status === 201);
  check('second buyer is told stock is gone (409)', second.status === 409 && second.data.details?.[0]?.available === 0, second.data);
  check('lamp stock is 0, never negative', (await call(`/products/${pC.id}`)).data.stock === 0);
  await call('/cart', { method: 'DELETE', token: A });

  console.log('\nOrder tracking + vendor workflow');
  check('customer sees own orders', (await call('/orders', { token: A })).data.length === 1);
  check("customer cannot read another customer's order (404)", (await call(`/orders/${o.id}`, { token: bob.token })).status === 404);
  let vo = (await call('/vendor/orders', { token: v1.token })).data;
  check('vendor sees only own items', vo.length === 2 && vo.every(i => i.orderId === o.id));
  const itemA = vo.find(i => i.name === 'Alpha Phone');
  const v2Items = (await call('/vendor/orders', { token: v2.token })).data;
  check('other vendor cannot touch the item (403)', (await call(`/vendor/items/${itemA.itemId}/status`, { method: 'PUT', token: v2.token, body: { status: 'CONFIRMED' } })).status === 403);
  check('cannot skip a step (409)', (await call(`/vendor/items/${itemA.itemId}/status`, { method: 'PUT', token: v1.token, body: { status: 'SHIPPED' } })).status === 409);
  for (const s of ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED']) {
    const x = await call(`/vendor/items/${itemA.itemId}/status`, { method: 'PUT', token: v1.token, body: { status: s } });
    check(`vendor advances item to ${s}`, x.status === 200 && x.data.status === s);
  }
  let od = (await call(`/orders/${o.id}`, { token: A })).data;
  check('order status follows the slowest item', od.status === 'PLACED' && od.items.find(i => i.name === 'Alpha Phone').status === 'DELIVERED');
  check('tracking timeline recorded', od.events.filter(e => e.itemId === itemA.itemId).length === 5);

  console.log('\nCancellation');
  const itemB = vo.find(i => i.name === 'Beta Shirt');
  const cx = await call(`/vendor/items/${itemB.itemId}/status`, { method: 'PUT', token: v1.token, body: { status: 'CANCELLED' } });
  check('vendor cancels an unshipped item', cx.status === 200 && cx.data.status === 'CANCELLED');
  check('cancelled item returns stock', (await call(`/products/${pB.id}`)).data.stock === 5);
  const dx = v2Items.find(i => i.name === 'Delta Book');
  check('customer cancels remaining unshipped items', (await call(`/orders/${o.id}/cancel`, { method: 'POST', token: A })).status === 200);
  od = (await call(`/orders/${o.id}`, { token: A })).data;
  check('shipped/delivered item cannot be cancelled', od.items.find(i => i.name === 'Alpha Phone').status === 'DELIVERED');
  check('Delta Book cancelled and stock restored', od.items.find(i => i.name === 'Delta Book').status === 'CANCELLED' && (await call(`/products/${pD.id}`)).data.stock === 50, dx);
  check('second cancel is refused (409)', (await call(`/orders/${o.id}/cancel`, { method: 'POST', token: A })).status === 409);

  console.log('\nInvoice + stats');
  const inv = await call(`/orders/${o.id}/invoice`, { token: A, raw: true });
  const buf = Buffer.from(await inv.arrayBuffer());
  check('invoice is a PDF', inv.status === 200 && buf.slice(0, 4).toString() === '%PDF' && buf.length > 1500, buf.length);
  check("other customer cannot download the invoice (404)", (await call(`/orders/${o.id}/invoice`, { token: bob.token, raw: true })).status === 404);
  const st = (await call('/vendor/stats', { token: v1.token })).data;
  check('vendor stats count only non-cancelled sales', st.unitsSold === 1 && st.revenuePaise === 50000, st);
  check('stats include 7-day series', st.daily.length === 7);
  check('customer cannot read vendor stats (403)', (await call('/vendor/stats', { token: A })).status === 403);

  console.log('\nGateway safety');
  check('internal endpoints are not exposed', (await call('/internal/products?ids=1')).status === 404);
  check('unknown API route is 404', (await call('/nothing-here')).status === 404);
  const direct = await fetch(`http://127.0.0.1:${P.catalog}/internal/products?ids=1`);
  check('catalog internal API rejects calls without the key (403)', direct.status === 403);

  console.log(`\n${passed} passed, ${failed} failed`);
  stop();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); stop(); process.exit(1); });
