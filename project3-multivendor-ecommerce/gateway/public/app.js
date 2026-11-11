/* ShopSphere storefront - hash-routed single page app (no build step, no dependencies). */
'use strict';

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = p => '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 });
const dt = ms => new Date(ms).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
let session = (() => { try { return JSON.parse(store.get('ss_user') || 'null'); } catch { return null; } })();
let token = store.get('ss_token');
let cartCount = 0;

const CAT_STYLE = {
  Electronics: ['\u{1F3A7}', '#6366f1,#22d3ee'], Fashion: ['\u{1F45F}', '#ec4899,#f59e0b'], 'Home & Kitchen': ['\u{1F373}', '#10b981,#84cc16'],
  Books: ['\u{1F4DA}', '#f97316,#facc15'], Sports: ['\u{1F9D8}', '#0ea5e9,#8b5cf6'],
};
const visual = (p, cls = '') => {
  const [emoji, grad] = CAT_STYLE[p.category] || ['\u{1F4E6}', '#64748b,#94a3b8'];
  const inner = p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="" loading="lazy">` : (ART(p.name || '') || emoji);
  return `<div class="pimg ${cls}" style="background:linear-gradient(135deg,${grad})" aria-hidden="true">${inner}</div>`;
};

function toast(msg, type = 'ok') {
  const t = document.createElement('div'); t.className = 'toast ' + (type === 'error' ? 'error' : ''); t.textContent = msg;
  $('#toasts').append(t); setTimeout(() => t.remove(), 3600);
}

async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch('/api' + path, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw && res.ok) return res;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { setSession(null); toast('Please sign in again', 'error'); location.hash = '#/login'; }
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; e.details = data.details; throw e; }
  return data;
}

function setSession(data) {
  session = data ? data.user : null; token = data ? data.token : null;
  store.set('ss_user', data ? JSON.stringify(data.user) : null); store.set('ss_token', token);
  cartCount = 0; renderNav(); refreshCartCount();
}
async function refreshCartCount() {
  if (!session || session.role !== 'customer') { cartCount = 0; return renderNav(); }
  try { cartCount = (await api('/cart')).count; } catch { cartCount = 0; }
  renderNav();
}

/* ---------- nav ---------- */
function renderNav() {
  const h = location.hash || '#/';
  const a = (href, label, extra = '') => `<a href="${href}" class="${h.startsWith(href) && href !== '#/' ? 'active' : ''}">${label}${extra}</a>`;
  let html = a('#/', 'Shop');
  if (!session) html += a('#/login', 'Sign in') + `<a href="#/register" class="active" style="background:var(--brand);color:var(--brand-ink)">Join</a>`;
  else if (session.role === 'vendor') html += a('#/vendor', 'Vendor dashboard') + `<button class="linklike" data-act="logout">Sign out (${esc(session.shopName || session.name)})</button>`;
  else html += a('#/cart', 'Cart', cartCount ? `<span class="badge-count">${cartCount}</span>` : '') + a('#/orders', 'My orders') + `<button class="linklike" data-act="logout">Sign out (${esc(session.name.split(' ')[0])})</button>`;
  $('#nav').innerHTML = html;
}

/* ---------- router ---------- */
const routes = [];
const route = (re, fn) => routes.push([re, fn]);
let navToken = 0;
async function router() {
  const hash = location.hash.slice(1) || '/';
  const [pathPart, qs] = hash.split('?');
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  renderNav();
  const my = ++navToken;
  for (const [re, fn] of routes) {
    const m = pathPart.match(re);
    if (!m) continue;
    app.innerHTML = '<div class="skeleton"></div>';
    try { const out = await fn(m.slice(1), q); if (my === navToken && typeof out === 'string') app.innerHTML = out; }
    catch (e) { if (my === navToken) app.innerHTML = `<div class="card empty"><div class="big">⚠️</div><h2>Something went wrong</h2><p>${esc(e.message)}</p><a href="#/">Back to shop</a></div>`; }
    if (my === navToken) { window.scrollTo(0, 0); document.title = ($('h1', app)?.textContent ? $('h1', app).textContent + ' · ' : '') + 'ShopSphere'; }
    return;
  }
  app.innerHTML = '<div class="card empty"><div class="big">\u{1F9ED}</div><h2>Page not found</h2><a href="#/">Back to shop</a></div>';
}
const needRole = role => {
  if (!session) { location.hash = '#/login'; return false; }
  if (session.role !== role) { app.innerHTML = `<div class="card empty"><div class="big">\u{1F512}</div><h2>${role === 'vendor' ? 'Vendors only' : 'Customers only'}</h2><p>You are signed in as a ${esc(session.role)}.</p></div>`; return false; }
  return true;
};

/* ---------- shop ---------- */
const SORTS = [['newest', 'Newest'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low'], ['name', 'Name A-Z'], ['stock', 'Most in stock']];
const qsOf = (q, over = {}) => { const o = { ...q, ...over }; Object.keys(o).forEach(k => (o[k] === '' || o[k] == null || (k === 'page' && +o[k] === 1)) && delete o[k]); const s = new URLSearchParams(o).toString(); return '#/' + (s ? '?' + s : ''); };

route(/^\/$/, async (_, q) => {
  const params = new URLSearchParams({ limit: 12, ...Object.fromEntries(Object.entries(q).filter(([, v]) => v !== '')) });
  const data = await api('/products?' + params);
  const f = data.facets || { categories: [], vendors: [] };
  const filterBox = `
    <aside class="card filters">
      <h3>Category</h3>
      <a class="cat ${!q.category ? 'on' : ''}" href="${qsOf(q, { category: '', page: 1 })}"><span>All</span></a>
      ${f.categories.map(c => `<a class="cat ${q.category === c.name ? 'on' : ''}" href="${qsOf(q, { category: c.name, page: 1 })}"><span>${esc(c.name)}</span><span class="muted">${c.count}</span></a>`).join('')}
      <h3>Vendor</h3>
      <select data-filter="vendor" aria-label="Vendor"><option value="">All vendors</option>${f.vendors.map(v => `<option value="${esc(v.id)}" ${String(q.vendor) === String(v.id) ? 'selected' : ''}>${esc(v.name)} (${v.count})</option>`).join('')}</select>
      <h3>Price (₹)</h3>
      <form data-form="price" class="row"><input name="minPrice" type="number" min="0" placeholder="Min" value="${esc(q.minPrice || '')}" aria-label="Minimum price"><input name="maxPrice" type="number" min="0" placeholder="Max" value="${esc(q.maxPrice || '')}" aria-label="Maximum price"><button class="sm">Go</button></form>
      <h3>Availability</h3>
      <label class="row" style="font-weight:500"><input type="checkbox" data-filter="inStock" ${q.inStock ? 'checked' : ''}> In stock only</label>
      ${Object.keys(q).some(k => k !== 'page') ? `<p><a href="#/">Clear all filters</a></p>` : ''}
    </aside>`;
  const grid = data.items.length ? `<div class="products">${data.items.map(p => `
      <article class="pcard">
        <a href="#/product/${p.id}" aria-label="${esc(p.name)}">${visual(p)}</a>
        <div class="pbody">
          <span class="small muted">${esc(p.vendorName)} &middot; ${esc(p.category)}</span>
          <a class="pname" href="#/product/${p.id}">${esc(p.name)}</a>
          <div class="pfoot"><span class="price">${money(p.pricePaise)}</span>
          ${p.stock === 0 ? '<span class="tag bad">Sold out</span>' : p.stock <= 5 ? `<span class="tag warn">Only ${p.stock} left</span>` : '<span class="tag ok">In stock</span>'}</div>
        </div>
      </article>`).join('')}</div>` : `<div class="card empty"><div class="big">\u{1F50D}</div><h2>No products match</h2><p>Try removing a filter or searching for something else.</p><a href="#/">Clear filters</a></div>`;
  const pager = data.pages > 1 ? `<nav class="pager" aria-label="Pages">${Array.from({ length: data.pages }, (_, i) => i + 1).map(n => n === data.page ? `<span class="on">${n}</span>` : `<a href="${qsOf(q, { page: n })}">${n}</a>`).join('')}</nav>` : '';
  const hero = !Object.keys(q).length ? `<section class="hero"><h1>Shop from independent vendors, one cart</h1><p>Browse products from ${f.vendors.length} verified sellers. Free shipping above ₹999. Try coupon <b>WELCOME10</b> at checkout.</p></section>` : '';
  const head = q.q ? `<h1>Results for "${esc(q.q)}"</h1>` : q.category ? `<h1>${esc(q.category)}</h1>` : '<h1>All products</h1>';
  $('input[name=q]').value = q.q || '';
  return `${hero}<div class="shop">${filterBox}<section>
    <div class="toolbar"><div>${head}<span class="muted small">${data.total} product${data.total === 1 ? '' : 's'}</span></div>
    <label class="row small" style="margin:0">Sort by <select data-filter="sort" style="margin-left:6px">${SORTS.map(([v, l]) => `<option value="${v}" ${(q.sort || 'newest') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
    ${grid}${pager}</section></div>`;
});

route(/^\/product\/(\d+)$/, async ([id]) => {
  const p = await api('/products/' + id);
  const canBuy = p.stock > 0 && (!session || session.role === 'customer');
  return `<p class="small"><a href="#/">&larr; All products</a> / <a href="#/?category=${encodeURIComponent(p.category)}">${esc(p.category)}</a></p>
  <div class="detail">${visual(p, 'big')}
    <div class="stack">
      <div><h1>${esc(p.name)}</h1><p class="muted">Sold by <a href="#/?vendor=${p.vendorId}">${esc(p.vendorName)}</a></p></div>
      <div class="price" style="font-size:30px">${money(p.pricePaise)} <span class="small muted" style="font-weight:500">+ 18% GST at checkout</span></div>
      ${p.stock === 0 ? '<span class="tag bad">Sold out</span>' : p.stock <= 5 ? `<span class="tag warn">Hurry, only ${p.stock} left</span>` : `<span class="tag ok">${p.stock} in stock</span>`}
      <p>${esc(p.description)}</p>
      ${session && session.role === 'vendor' ? '<div class="note">Vendors cannot purchase. Sign in as a customer to shop.</div>' : `
      <div class="row wrapflex"><div class="qty" data-qty><button data-act="dec" aria-label="Less">&minus;</button><span id="qv">1</span><button data-act="inc" aria-label="More">+</button></div>
      <button class="primary" data-act="add" data-id="${p.id}" data-max="${p.stock}" ${canBuy ? '' : 'disabled'}>Add to cart</button>
      <button data-act="buynow" data-id="${p.id}" data-max="${p.stock}" ${canBuy ? '' : 'disabled'}>Buy now</button></div>`}
      <div class="note">Secure checkout &middot; Cash on delivery &middot; Easy cancellation before dispatch</div>
    </div></div>`;
});

/* ---------- auth ---------- */
route(/^\/login$/, async () => `
  <div class="grid2" style="max-width:860px;margin:10px auto">
    <form class="card" data-form="login"><h1>Sign in</h1><p class="muted">Welcome back.</p><div id="msg"></div>
      <div class="field"><label for="e">Email</label><input id="e" name="email" type="email" required autocomplete="username"></div>
      <div class="field"><label for="p">Password</label><input id="p" name="password" type="password" required autocomplete="current-password"></div>
      <button class="primary block">Sign in</button><p class="small muted">New here? <a href="#/register">Create an account</a></p></form>
    <div class="card"><h3>Demo accounts (click to fill)</h3><p class="small muted">Created automatically by the seed script.</p>
      ${[['Customer', 'demo@shop.test', 'Demo@1234'], ['Vendor: TechHub', 'techhub@shop.test', 'Vendor@123'], ['Vendor: Fashionista', 'fashionista@shop.test', 'Vendor@123'], ['Vendor: HomeNest', 'homenest@shop.test', 'Vendor@123'], ['Vendor: PageTurner', 'pageturner@shop.test', 'Vendor@123']]
        .map(([l, e, p]) => `<button class="block" style="text-align:left;margin-bottom:8px" data-act="fill" data-e="${e}" data-p="${p}"><b>${l}</b><br><span class="small muted">${e}</span></button>`).join('')}</div></div>`);

route(/^\/register$/, async () => `
  <form class="card" data-form="register" style="max-width:460px;margin:10px auto"><h1>Create account</h1><div id="msg"></div>
    <div class="field"><label>I want to</label>
      <label class="radio"><input type="radio" name="role" value="customer" checked> <span>Shop &mdash; buy products</span></label>
      <label class="radio"><input type="radio" name="role" value="vendor"> <span>Sell &mdash; open a vendor shop</span></label></div>
    <div class="field"><label for="n">Full name</label><input id="n" name="name" required maxlength="80"></div>
    <div class="field" id="shopf" hidden><label for="s">Shop name</label><input id="s" name="shopName" maxlength="60"></div>
    <div class="field"><label for="e">Email</label><input id="e" name="email" type="email" required autocomplete="username"></div>
    <div class="field"><label for="p">Password (min 8 characters)</label><input id="p" name="password" type="password" required minlength="8" autocomplete="new-password"></div>
    <button class="primary block">Create account</button><p class="small muted">Already registered? <a href="#/login">Sign in</a></p></form>`);

/* ---------- cart & checkout ---------- */
let couponCode = '';
function summary(c, withCoupon = true) {
  return `<div class="sum">
    <div><span>Subtotal (${c.count} item${c.count === 1 ? '' : 's'})</span><span>${money(c.subtotalPaise)}</span></div>
    ${c.discountPaise ? `<div class="save"><span>Discount ${c.coupon ? '(' + esc(c.coupon.code) + ')' : ''}</span><span>&minus; ${money(c.discountPaise)}</span></div>` : ''}
    <div><span>Shipping</span><span>${c.shippingPaise ? money(c.shippingPaise) : 'FREE'}</span></div>
    <div><span>GST (${c.gstPercent}%)</span><span>${money(c.taxPaise)}</span></div>
    <div class="total"><span>Total</span><span>${money(c.totalPaise)}</span></div></div>
    ${!c.shippingPaise || !c.subtotalPaise ? '' : `<p class="small muted">Add ${money(Math.max(0, c.freeShippingFromPaise - (c.subtotalPaise - c.discountPaise)))} more for free shipping.</p>`}`;
}
const couponBox = c => `<form data-form="coupon" class="coupon"><input name="code" placeholder="Coupon code" value="${esc(couponCode)}" aria-label="Coupon code"><button class="sm">Apply</button></form>
  ${c.couponError ? `<p class="small" style="color:var(--bad)">${esc(c.couponError)}</p>` : c.coupon ? `<p class="small" style="color:var(--ok)">✓ ${esc(c.coupon.label)}</p>` : '<p class="small muted">Try WELCOME10, FLAT100 or FREESHIP</p>'}`;

route(/^\/cart$/, async () => {
  if (!needRole('customer')) return;
  const c = await api('/cart' + (couponCode ? '?coupon=' + encodeURIComponent(couponCode) : ''));
  cartCount = c.count; renderNav();
  if (!c.items.length) return `<div class="card empty"><div class="big">\u{1F6D2}</div><h2>Your cart is empty</h2><p>Add something you like.</p><a href="#/"><button class="primary">Continue shopping</button></a></div>`;
  return `<h1>Your cart</h1><div class="two-col" style="margin-top:14px">
    <div class="card">${c.items.map(i => `
      <div class="line"><a href="#/product/${i.productId}">${visual(i)}</a>
        <div><a class="pname" href="#/product/${i.productId}">${esc(i.name)}</a><div class="small muted">Sold by ${esc(i.vendorName)} &middot; ${money(i.pricePaise)} each</div>
          ${i.issue ? `<div class="small" style="color:var(--bad)">${esc(i.issue)}</div>` : ''}</div>
        <div class="qty"><button data-act="cqty" data-id="${i.productId}" data-q="${i.qty - 1}" aria-label="Less">&minus;</button><span>${i.qty}</span><button data-act="cqty" data-id="${i.productId}" data-q="${i.qty + 1}" ${i.qty >= i.stock ? 'disabled' : ''} aria-label="More">+</button></div>
        <div class="right"><b>${money(i.lineTotalPaise)}</b><br><button class="sm danger" data-act="crm" data-id="${i.productId}">Remove</button></div></div>`).join('')}</div>
    <aside class="card stack"><h2>Order summary</h2>${couponBox(c)}${summary(c)}
      <a href="#/checkout"><button class="primary block" ${c.hasIssues ? 'disabled' : ''}>Proceed to checkout</button></a></aside></div>`;
});

route(/^\/checkout$/, async () => {
  if (!needRole('customer')) return;
  const c = await api('/cart' + (couponCode ? '?coupon=' + encodeURIComponent(couponCode) : ''));
  if (!c.items.length) { location.hash = '#/cart'; return; }
  const u = session || {};
  const pay = [['COD', 'Cash on delivery', 'Pay when the order arrives'], ['CARD_TEST', 'Credit / debit card (test mode)', 'Simulated, no real money moves'], ['UPI_TEST', 'UPI (test mode)', 'Simulated, no real money moves']];
  return `<h1>Checkout</h1><form data-form="checkout" class="two-col" style="margin-top:14px">
    <div class="stack"><div class="card"><h2>Delivery address</h2><div id="msg"></div>
      <div class="grid2"><div class="field"><label>Full name</label><input name="name" required value="${esc(u.name)}"></div><div class="field"><label>Phone (10 digits)</label><input name="phone" required inputmode="numeric" pattern="[0-9]{10}" maxlength="10"></div></div>
      <div class="field"><label>Address</label><input name="line1" required placeholder="House no, street, area"></div>
      <div class="grid3"><div class="field"><label>City</label><input name="city" required></div><div class="field"><label>State</label><input name="state" required></div><div class="field"><label>PIN code</label><input name="pin" required inputmode="numeric" pattern="[0-9]{6}" maxlength="6"></div></div></div>
      <div class="card"><h2>Payment</h2>${pay.map(([v, l, d], i) => `<label class="radio"><input type="radio" name="pay" value="${v}" ${i === 0 ? 'checked' : ''}><span>${l}<br><span class="small muted">${d}</span></span></label>`).join('')}</div></div>
    <aside class="card stack"><h2>Order summary</h2>
      ${c.items.map(i => `<div class="row between small"><span>${esc(i.name)} &times; ${i.qty}</span><span>${money(i.lineTotalPaise)}</span></div>`).join('')}
      ${summary(c)}<button class="primary block" id="placeBtn">Place order &middot; ${money(c.totalPaise)}</button>
      <a class="small" href="#/cart">&larr; Edit cart</a></aside></form>`;
});

/* ---------- orders ---------- */
const FLOW = ['PLACED', 'CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED'];
const TAGC = { PLACED: 'info', CONFIRMED: 'info', PACKED: 'warn', SHIPPED: 'warn', DELIVERED: 'ok', CANCELLED: 'bad', PAID: 'ok', PENDING: 'warn' };
const tag = s => `<span class="tag ${TAGC[s] || ''}">${esc(s)}</span>`;
const payLabel = m => ({ COD: 'Cash on delivery', CARD_TEST: 'Card (test)', UPI_TEST: 'UPI (test)' }[m] || m);
const stepper = status => {
  if (status === 'CANCELLED') return '<div class="small" style="color:var(--bad);font-weight:600">Cancelled</div>';
  const at = FLOW.indexOf(status);
  return `<div class="stepper">${FLOW.map((s, i) => `<div class="step ${i <= at ? 'done' : ''} ${i === at ? 'now' : ''}"><i></i>${s[0] + s.slice(1).toLowerCase()}</div>`).join('')}</div>`;
};

route(/^\/orders$/, async () => {
  if (!needRole('customer')) return;
  const list = await api('/orders');
  if (!list.length) return `<div class="card empty"><div class="big">\u{1F4E6}</div><h2>No orders yet</h2><a href="#/"><button class="primary">Start shopping</button></a></div>`;
  return `<h1>My orders</h1><div class="stack" style="margin-top:14px">${list.map(o => `
    <a class="card ocard" href="#/orders/${o.id}"><div class="row between wrapflex"><div><b>Order #${o.id}</b> <span class="muted small">&middot; ${dt(o.createdAt)}</span></div><div>${tag(o.status)} ${tag(o.paymentStatus)}</div></div>
      <div class="small muted" style="margin:6px 0">${o.items.map(i => `${esc(i.name)} &times; ${i.qty}`).join(', ')}</div>
      <div class="row between"><span class="small muted">${payLabel(o.paymentMethod)}</span><b>${money(o.totalPaise)}</b></div></a>`).join('')}</div>`;
});

route(/^\/orders\/(\d+)$/, async ([id]) => {
  if (!needRole('customer')) return;
  const o = await api('/orders/' + id);
  const canCancel = o.items.some(i => ['PLACED', 'CONFIRMED'].includes(i.status));
  const byItem = Object.fromEntries(o.items.map(i => [i.id, i.name]));
  return `<p class="small"><a href="#/orders">&larr; My orders</a></p>
  <div class="row between wrapflex"><div><h1>Order #${o.id}</h1><span class="muted small">Placed ${dt(o.createdAt)} &middot; Invoice ${esc(o.invoiceNo)}</span></div>
    <div class="row">${tag(o.status)} ${tag(o.paymentStatus)}<button data-act="invoice" data-id="${o.id}" data-no="${esc(o.invoiceNo)}">Download invoice (PDF)</button>${canCancel ? `<button class="danger" data-act="cancel" data-id="${o.id}">Cancel order</button>` : ''}</div></div>
  <div class="two-col" style="margin-top:14px"><div class="stack">
    <div class="card"><h2>Items &amp; tracking</h2>${o.items.map(i => `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
      <div class="row between wrapflex"><div><b>${esc(i.name)}</b> &times; ${i.qty}<div class="small muted">Sold by ${esc(i.vendorName)}</div></div><div class="right"><b>${money(i.lineTotalPaise)}</b><br>${tag(i.status)}</div></div>${stepper(i.status)}</div>`).join('')}</div>
    <div class="card"><h2>Activity</h2><ul class="timeline">${[...o.events].reverse().map(e => `<li class="${e.status === 'CANCELLED' ? 'cancel' : ''}"><b>${esc(e.status)}</b> <span class="small muted">${dt(e.ts)}</span><div class="small">${esc(e.note)} <span class="muted">&middot; ${esc(e.actor)}</span></div></li>`).join('')}</ul></div></div>
    <aside class="stack"><div class="card"><h2>Payment</h2><p>${payLabel(o.paymentMethod)}<br><span class="small muted">${o.transactionId ? 'Txn ' + esc(o.transactionId) : 'To be collected on delivery'}</span></p>
      <div class="sum"><div><span>Subtotal</span><span>${money(o.subtotalPaise)}</span></div>${o.discountPaise ? `<div class="save"><span>Discount${o.couponCode ? ' (' + esc(o.couponCode) + ')' : ''}</span><span>&minus; ${money(o.discountPaise)}</span></div>` : ''}<div><span>Shipping</span><span>${o.shippingPaise ? money(o.shippingPaise) : 'FREE'}</span></div><div><span>GST</span><span>${money(o.taxPaise)}</span></div><div class="total"><span>Total</span><span>${money(o.totalPaise)}</span></div></div></div>
      <div class="card"><h2>Ship to</h2><p class="small">${esc(o.address.name)}<br>${esc(o.address.line1)}<br>${esc(o.address.city)}, ${esc(o.address.state)} ${esc(o.address.pin)}<br>Phone ${esc(o.address.phone)}</p></div></aside></div>`;
});

/* ---------- vendor dashboard ---------- */
const TABS = [['overview', 'Overview'], ['products', 'Products'], ['orders', 'Orders']];
const tabs = on => `<div class="tabs">${TABS.map(([k, l]) => `<a href="#/vendor${k === 'overview' ? '' : '/' + k}" class="${on === k ? 'on' : ''}">${l}</a>`).join('')}</div>`;
const vendorHead = on => `<div class="row between wrapflex"><div><h1>${esc(session.shopName || 'My shop')}</h1><span class="muted small">Vendor dashboard</span></div></div>${tabs(on)}`;

function barChart(daily) {
  const W = 560, H = 190, pad = 28, max = Math.max(1, ...daily.map(d => d.revenuePaise)), bw = (W - pad * 2) / daily.length;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Revenue over the last 7 days">
    ${[0, .5, 1].map(f => `<line x1="${pad}" x2="${W - pad}" y1="${H - 26 - f * (H - 50)}" y2="${H - 26 - f * (H - 50)}" stroke="var(--border)"/>`).join('')}
    ${daily.map((d, i) => { const h = d.revenuePaise / max * (H - 50), x = pad + i * bw + bw * .18;
      return `<g><rect class="bar" x="${x}" y="${H - 26 - h}" width="${bw * .64}" height="${Math.max(h, d.revenuePaise ? 2 : 0)}" rx="4"><title>${d.day}: ${money(d.revenuePaise)} (${d.orders} orders)</title></rect>
      <text x="${x + bw * .32}" y="${H - 9}" text-anchor="middle">${d.day.slice(5)}</text>${d.revenuePaise ? `<text x="${x + bw * .32}" y="${H - 30 - h}" text-anchor="middle">${money(d.revenuePaise)}</text>` : ''}</g>`; }).join('')}</svg>`;
}

route(/^\/vendor$/, async () => {
  if (!needRole('vendor')) return;
  const s = await api('/vendor/stats');
  const topMax = Math.max(1, ...s.topProducts.map(p => p.revenuePaise));
  return `${vendorHead('overview')}
  <div class="stats">${[['Revenue', money(s.revenuePaise)], ['Orders', s.ordersCount], ['Units sold', s.unitsSold], ['Awaiting action', (s.statusCounts.PLACED || 0) + (s.statusCounts.CONFIRMED || 0) + (s.statusCounts.PACKED || 0)]].map(([l, v]) => `<div class="card stat"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('')}</div>
  <div class="grid2" style="grid-template-columns:3fr 2fr"><div class="card"><h2>Revenue &mdash; last 7 days</h2>${barChart(s.daily)}</div>
    <div class="card"><h2>Top products</h2>${s.topProducts.length ? s.topProducts.map(p => `<div><div class="row between small"><span>${esc(p.name)}</span><b>${money(p.revenuePaise)}</b></div><div class="bar-row"><div class="track"><div class="fill" style="width:${p.revenuePaise / topMax * 100}%"></div></div><span class="small muted nowrap">${p.units} sold</span></div></div>`).join('') : '<p class="muted">No sales yet.</p>'}
      <h3 style="margin-top:16px">Order status</h3>${Object.entries(s.statusCounts).map(([k, v]) => `${tag(k)} <b>${v}</b> `).join('') || '<span class="muted small">None</span>'}</div></div>`;
});

route(/^\/vendor\/products$/, async () => {
  if (!needRole('vendor')) return;
  const list = await api('/vendor/products');
  return `${vendorHead('products')}<div class="row between" style="margin-bottom:12px"><span class="muted">${list.length} product${list.length === 1 ? '' : 's'}</span><button class="primary" data-act="newprod">+ Add product</button></div>
  <div id="prodform"></div>
  <div class="card tablewrap"><table><thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th></th></tr></thead><tbody>
    ${list.map(p => `<tr><td><b>${esc(p.name)}</b></td><td>${esc(p.category)}</td><td>${money(p.pricePaise)}</td><td>${p.stock === 0 ? '<span class="tag bad">0</span>' : p.stock <= 5 ? `<span class="tag warn">${p.stock}</span>` : p.stock}</td>
      <td class="right nowrap"><button class="sm" data-act="editprod" data-id="${p.id}">Edit</button> <button class="sm danger" data-act="delprod" data-id="${p.id}" data-name="${esc(p.name)}">Delete</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No products yet.</td></tr>'}</tbody></table></div>`;
});

const prodForm = p => `<form class="card" data-form="product" data-id="${p ? p.id : ''}" style="margin-bottom:16px"><h2>${p ? 'Edit product' : 'New product'}</h2><div id="msg"></div>
  <div class="grid2"><div class="field"><label>Name</label><input name="name" required maxlength="120" value="${esc(p?.name)}"></div>
  <div class="field"><label>Category</label><input name="category" required list="cats" maxlength="40" value="${esc(p?.category)}"><datalist id="cats">${Object.keys(CAT_STYLE).map(c => `<option>${esc(c)}</option>`).join('')}</datalist></div></div>
  <div class="field"><label>Description</label><textarea name="description" maxlength="1000">${esc(p?.description)}</textarea></div>
  <div class="grid3"><div class="field"><label>Price (₹)</label><input name="price" type="number" min="1" step="0.01" required value="${p ? p.pricePaise / 100 : ''}"></div>
  <div class="field"><label>Stock</label><input name="stock" type="number" min="0" step="1" required value="${p ? p.stock : ''}"></div>
  <div class="field"><label>Image URL (optional)</label><input name="imageUrl" type="url" value="${esc(p?.imageUrl)}"></div></div>
  <div class="row"><button class="primary">${p ? 'Save changes' : 'Create product'}</button><button type="button" data-act="cancelprod">Cancel</button></div></form>`;

route(/^\/vendor\/orders$/, async () => {
  if (!needRole('vendor')) return;
  const list = await api('/vendor/orders');
  return `${vendorHead('orders')}<div class="card tablewrap"><table><thead><tr><th>Order</th><th>Item</th><th>Customer / ship to</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map(i => `<tr><td><b>#${i.orderId}</b><br><span class="small muted">${dt(i.createdAt)}</span></td><td>${esc(i.name)} &times; ${i.qty}</td>
      <td class="small">${esc(i.customerName)}<br><span class="muted">${esc(i.address.city)}, ${esc(i.address.state)} ${esc(i.address.pin)}</span></td><td>${money(i.lineTotalPaise)}<br><span class="small muted">${payLabel(i.paymentMethod)}</span></td>
      <td>${tag(i.status)}</td><td class="right nowrap">${i.next ? `<button class="sm primary" data-act="advance" data-id="${i.itemId}" data-to="${i.next}">Mark ${i.next.toLowerCase()}</button>` : ''} ${i.canCancel ? `<button class="sm danger" data-act="vcancel" data-id="${i.itemId}">Cancel</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No orders yet.</td></tr>'}</tbody></table></div>`;
});

/* ---------- events ---------- */
const reload = () => router();
const flash = (el, msg) => { const m = el.querySelector('#msg'); if (m) m.innerHTML = `<div class="err">${esc(msg)}</div>`; else toast(msg, 'error'); };
const fd = form => Object.fromEntries(new FormData(form));

document.addEventListener('submit', async ev => {
  const form = ev.target.closest('form[data-form]'); if (!form) return;
  ev.preventDefault();
  const kind = form.dataset.form, d = fd(form), btn = form.querySelector('button:not([type=button])');
  if (btn) btn.disabled = true;
  try {
    if (kind === 'search') { location.hash = d.q.trim() ? '#/?q=' + encodeURIComponent(d.q.trim()) : '#/'; }
    else if (kind === 'price') { const q = Object.fromEntries(new URLSearchParams((location.hash.split('?')[1]) || '')); location.hash = qsOf(q, { minPrice: d.minPrice, maxPrice: d.maxPrice, page: 1 }); }
    else if (kind === 'login') { const r = await api('/auth/login', { method: 'POST', body: d }); setSession(r); toast('Welcome back, ' + r.user.name.split(' ')[0]); location.hash = r.user.role === 'vendor' ? '#/vendor' : '#/'; }
    else if (kind === 'register') {
      const r = await api('/auth/register', { method: 'POST', body: { name: d.name, email: d.email, password: d.password, role: d.role, shopName: d.role === 'vendor' ? d.shopName : undefined } });
      setSession(r); toast('Account created'); location.hash = r.user.role === 'vendor' ? '#/vendor/products' : '#/';
    }
    else if (kind === 'coupon') { couponCode = d.code.trim().toUpperCase(); reload(); }
    else if (kind === 'checkout') {
      const address = { name: d.name, phone: d.phone, line1: d.line1, city: d.city, state: d.state, pin: d.pin };
      const o = await api('/checkout', { method: 'POST', body: { address, paymentMethod: d.pay, coupon: couponCode || undefined } });
      couponCode = ''; cartCount = 0; toast(`Order #${o.id} placed!`); location.hash = '#/orders/' + o.id; refreshCartCount();
    }
    else if (kind === 'product') {
      const body = { name: d.name, category: d.category, description: d.description, pricePaise: Math.round(parseFloat(d.price) * 100), stock: parseInt(d.stock, 10), imageUrl: d.imageUrl || '' };
      await api(form.dataset.id ? '/products/' + form.dataset.id : '/products', { method: form.dataset.id ? 'PUT' : 'POST', body });
      toast(form.dataset.id ? 'Product updated' : 'Product created'); reload();
    }
  } catch (e) {
    const extra = e.details ? ' ' + (Array.isArray(e.details) ? e.details.map(x => x.name ? `${x.name}: only ${x.available} left` : JSON.stringify(x)).join('; ') : '') : '';
    flash(form, e.message + extra); if (btn) btn.disabled = false;
  }
});

document.addEventListener('change', ev => {
  const t = ev.target;
  if (t.matches('input[name=role]')) { const v = $('#shopf'); if (v) { v.hidden = t.value !== 'vendor'; $('input', v).required = t.value === 'vendor'; } }
  if (t.dataset.filter) { const q = Object.fromEntries(new URLSearchParams((location.hash.split('?')[1]) || '')); location.hash = qsOf(q, { [t.dataset.filter]: t.type === 'checkbox' ? (t.checked ? '1' : '') : t.value, page: 1 }); }
});

document.addEventListener('click', async ev => {
  const b = ev.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, id = b.dataset.id;
  const guard = async fn => { b.disabled = true; try { await fn(); } catch (e) { toast(e.message, 'error'); } finally { b.disabled = false; } };
  const qtyEl = $('#qv'), qty = qtyEl ? +qtyEl.textContent : 1;
  if (act === 'inc' || act === 'dec') { const max = +($('[data-act=add]')?.dataset.max || 99); qtyEl.textContent = Math.min(max, Math.max(1, qty + (act === 'inc' ? 1 : -1))); }
  else if (act === 'logout') { setSession(null); toast('Signed out'); location.hash = '#/'; }
  else if (act === 'fill') { $('#e').value = b.dataset.e; $('#p').value = b.dataset.p; }
  else if (act === 'add' || act === 'buynow') {
    if (!session) { toast('Please sign in to add items to your cart', 'error'); location.hash = '#/login'; return; }
    guard(async () => { await api('/cart/items', { method: 'POST', body: { productId: +id, qty } }); await refreshCartCount(); if (act === 'buynow') location.hash = '#/checkout'; else toast('Added to cart'); });
  }
  else if (act === 'cqty') { if (+b.dataset.q < 1) return; guard(async () => { await api('/cart/items/' + id, { method: 'PUT', body: { qty: +b.dataset.q } }); reload(); }); }
  else if (act === 'crm') guard(async () => { await api('/cart/items/' + id, { method: 'DELETE' }); reload(); });
  else if (act === 'cancel') { if (confirm('Cancel this order? Stock will be released.')) guard(async () => { await api(`/orders/${id}/cancel`, { method: 'POST' }); toast('Order cancelled'); reload(); }); }
  else if (act === 'invoice') guard(async () => {
    const res = await api(`/orders/${id}/invoice`, { raw: true }), url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a'); a.href = url; a.download = (b.dataset.no || 'invoice') + '.pdf'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
  else if (act === 'newprod') { $('#prodform').innerHTML = prodForm(null); $('#prodform input').focus(); }
  else if (act === 'cancelprod') $('#prodform').innerHTML = '';
  else if (act === 'editprod') guard(async () => { $('#prodform').innerHTML = prodForm(await api('/products/' + id)); $('#prodform').scrollIntoView({ behavior: 'smooth' }); });
  else if (act === 'delprod') { if (confirm(`Delete "${b.dataset.name}"? It will be hidden from the shop.`)) guard(async () => { await api('/products/' + id, { method: 'DELETE' }); toast('Product deleted'); reload(); }); }
  else if (act === 'advance') guard(async () => { await api(`/vendor/items/${id}/status`, { method: 'PUT', body: { status: b.dataset.to } }); toast('Marked ' + b.dataset.to.toLowerCase()); reload(); });
  else if (act === 'vcancel') { if (confirm('Cancel this item? Stock will be released.')) guard(async () => { await api(`/vendor/items/${id}/status`, { method: 'PUT', body: { status: 'CANCELLED' } }); toast('Item cancelled'); reload(); }); }
});

/* ---------- footer health ---------- */
async function health() {
  const el = $('#health');
  try { const h = await (await fetch('/api/health')).json(); el.className = 'health ' + (h.ok ? 'up' : 'down'); el.textContent = h.ok ? 'All services online' : 'Degraded: ' + (h.services || []).filter(v => v.status !== 'UP').map(v => v.name).join(', '); }
  catch { el.className = 'health down'; el.textContent = 'Gateway unreachable'; }
}

window.addEventListener('hashchange', router);
renderNav(); refreshCartCount(); router(); health(); setInterval(health, 15000);
