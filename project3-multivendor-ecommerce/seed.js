/**
 * Loads demo accounts, products and a few sample orders through the public API
 * (so it also exercises the services). Safe to run repeatedly: it only adds data to empty stores.
 *   node seed.js     (or: npm run seed)
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:' + (process.env.PORT || 4000);

async function call(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(BASE + '/api' + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, data };
}

async function account(name, email, password, role, shopName) {
  let r = await call('/auth/register', { method: 'POST', body: { name, email, password, role, shopName } });
  if (r.status === 409) r = await call('/auth/login', { method: 'POST', body: { email, password } });
  if (!r.ok) throw new Error(`could not create/login ${email}: ${r.data.error}`);
  return r.data;
}

const VENDORS = [
  { name: 'Arjun Mehta', email: 'techhub@shop.test', shop: 'TechHub', products: [
    ['Wireless Noise-Cancelling Headphones', 'Electronics', 4999, 25, 'Over-ear Bluetooth headphones with 30-hour battery life and active noise cancellation.'],
    ['Smart Fitness Band', 'Electronics', 1999, 40, 'Heart-rate, sleep and step tracking with a 14-day battery and a bright AMOLED display.'],
    ['Portable Bluetooth Speaker', 'Electronics', 2499, 30, 'Waterproof 20W speaker with deep bass and 12 hours of playtime.'],
    ['20000 mAh Power Bank', 'Electronics', 1499, 60, 'Fast-charging power bank with dual USB-C ports and a digital battery display.'],
    ['Mechanical Gaming Keyboard', 'Electronics', 3299, 18, 'RGB backlit keyboard with hot-swappable blue switches and aluminium frame.'],
    ['USB-C Fast Charger 65W', 'Electronics', 1299, 80, 'Compact GaN charger that powers a laptop, tablet and phone at full speed.'],
  ] },
  { name: 'Riya Kapoor', email: 'fashionista@shop.test', shop: 'Fashionista', products: [
    ['Classic Cotton T-Shirt', 'Fashion', 599, 120, 'Soft 100% cotton crew-neck tee, pre-shrunk and available in everyday colours.'],
    ['Slim Fit Denim Jeans', 'Fashion', 1799, 45, 'Stretch denim jeans with a modern slim fit and reinforced stitching.'],
    ['Running Sneakers', 'Fashion', 2799, 35, 'Lightweight breathable sneakers with cushioned soles for daily runs.'],
    ['Leather Wallet', 'Fashion', 899, 70, 'Genuine leather bi-fold wallet with RFID protection and six card slots.'],
    ['Hooded Sweatshirt', 'Fashion', 1599, 3, 'Warm fleece-lined hoodie with a kangaroo pocket. Almost sold out!'],
  ] },
  { name: 'Neha Sharma', email: 'homenest@shop.test', shop: 'HomeNest', products: [
    ['Non-Stick Cookware Set (5 pcs)', 'Home & Kitchen', 3499, 22, 'Induction-friendly non-stick set with kadai, fry pan, tawa and lids.'],
    ['Electric Kettle 1.5L', 'Home & Kitchen', 899, 55, 'Stainless-steel kettle with auto shut-off and boil-dry protection.'],
    ['Ceramic Dinner Set (18 pcs)', 'Home & Kitchen', 2599, 15, 'Elegant microwave-safe dinner set for six with a matte glaze finish.'],
    ['Memory Foam Pillow', 'Home & Kitchen', 999, 50, 'Ergonomic cervical pillow with a washable bamboo cover.'],
    ['LED Desk Lamp', 'Home & Kitchen', 1199, 40, 'Dimmable desk lamp with 3 colour modes and a USB charging port.'],
  ] },
  { name: 'Karan Verma', email: 'pageturner@shop.test', shop: 'PageTurner', products: [
    ['Atomic Habits (Paperback)', 'Books', 499, 90, 'A practical guide to building good habits and breaking bad ones, by James Clear.'],
    ['The Pragmatic Programmer', 'Books', 1299, 28, 'Classic handbook of software craftsmanship for developers at every level.'],
    ['Clean Code', 'Books', 1099, 33, 'A handbook of agile software craftsmanship by Robert C. Martin.'],
    ['Yoga Mat (6 mm)', 'Sports', 799, 65, 'Non-slip, extra-cushioned exercise mat with a carry strap.'],
  ] },
];

(async () => {
  const customer = await account('Demo Customer', 'demo@shop.test', 'Demo@1234', 'customer');
  const vendors = [];
  for (const v of VENDORS) vendors.push({ ...v, auth: await account(v.name, v.email, 'Vendor@123', 'vendor', v.shop) });

  const existing = await call('/products?limit=1');
  if (existing.data.total === 0) {
    for (const v of vendors) {
      for (const [name, category, rupees, stock, description] of v.products) {
        const r = await call('/products', { method: 'POST', token: v.auth.token, body: { name, category, pricePaise: rupees * 100, stock, description } });
        if (!r.ok) throw new Error(`product "${name}": ${r.data.error}`);
      }
    }
    console.log(`[seed] created ${vendors.reduce((n, v) => n + v.products.length, 0)} products for ${vendors.length} vendors`);
  } else console.log('[seed] catalogue already has products, skipping');

  const orders = await call('/orders', { token: customer.token });
  if (orders.ok && orders.data.length === 0) {
    const list = (await call('/products?limit=48&sort=name')).data.items;
    const by = n => list.find(p => p.name.startsWith(n));
    const address = { name: 'Demo Customer', phone: '9876543210', line1: '12, MG Road, Indiranagar', city: 'Bengaluru', state: 'Karnataka', pin: '560038' };
    const place = async (lines, paymentMethod, coupon) => {
      await call('/cart', { method: 'DELETE', token: customer.token });
      for (const [n, qty] of lines) await call('/cart/items', { method: 'POST', token: customer.token, body: { productId: by(n).id, qty } });
      const r = await call('/checkout', { method: 'POST', token: customer.token, body: { address, paymentMethod, coupon } });
      if (!r.ok) throw new Error('sample order failed: ' + r.data.error);
      return r.data;
    };
    const advance = async (order, vendorEmail, steps) => {
      const v = vendors.find(x => x.email === vendorEmail);
      const mine = (await call('/vendor/orders', { token: v.auth.token })).data.filter(i => i.orderId === order.id);
      for (const item of mine) for (let s = 0; s < steps; s++) {
        const cur = (await call('/vendor/orders', { token: v.auth.token })).data.find(i => i.itemId === item.itemId);
        if (cur.next) await call(`/vendor/items/${item.itemId}/status`, { method: 'PUT', token: v.auth.token, body: { status: cur.next } });
      }
    };
    const o1 = await place([['Wireless Noise', 1], ['Classic Cotton', 2]], 'UPI_TEST', 'WELCOME10');
    await advance(o1, 'techhub@shop.test', 4); await advance(o1, 'fashionista@shop.test', 4);
    const o2 = await place([['Running Sneakers', 1], ['Electric Kettle', 1]], 'CARD_TEST');
    await advance(o2, 'fashionista@shop.test', 3); await advance(o2, 'homenest@shop.test', 1);
    await place([['Atomic Habits', 1], ['Yoga Mat', 1], ['LED Desk', 1]], 'COD');
    await call('/cart', { method: 'DELETE', token: customer.token });
    console.log('[seed] created 3 sample orders for demo@shop.test');
  }
  console.log('[seed] done');
})().catch(e => { console.error('[seed] failed:', e.message); process.exit(1); });
