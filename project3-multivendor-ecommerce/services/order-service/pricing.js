/**
 * Cart pricing rules (single source of truth for the cart view AND checkout).
 * All amounts are integer paise.
 */
const FREE_SHIPPING_FROM = 99900;  // free shipping when payable amount (before tax) >= Rs. 999
const SHIPPING_FEE = 4900;         // Rs. 49 otherwise
const GST_RATE = 0.18;

const COUPONS = {
  WELCOME10: { type: 'percent', value: 10, min: 0, label: '10% off your order' },
  FLAT100: { type: 'flat', value: 10000, min: 50000, label: 'Rs. 100 off on orders above Rs. 500' },
  FREESHIP: { type: 'shipping', value: 0, min: 0, label: 'Free shipping' },
};

/** lines: [{ pricePaise, qty }] */
function price(lines, couponCode) {
  const subtotal = lines.reduce((s, l) => s + l.pricePaise * l.qty, 0);
  let discount = 0, freeShip = false, coupon = null, couponError = null;

  const code = String(couponCode || '').trim().toUpperCase();
  if (code) {
    const c = COUPONS[code];
    if (!c) couponError = 'Invalid coupon code';
    else if (subtotal < c.min) couponError = `${code} needs a cart value of at least Rs. ${c.min / 100}`;
    else {
      coupon = { code, label: c.label };
      if (c.type === 'percent') discount = Math.round(subtotal * c.value / 100);
      if (c.type === 'flat') discount = Math.min(c.value, subtotal);
      if (c.type === 'shipping') freeShip = true;
    }
  }

  const taxable = subtotal - discount;
  const shipping = subtotal === 0 || freeShip || taxable >= FREE_SHIPPING_FROM ? 0 : SHIPPING_FEE;
  const tax = Math.round(taxable * GST_RATE);
  return { subtotalPaise: subtotal, discountPaise: discount, shippingPaise: shipping, taxPaise: tax,
           totalPaise: taxable + shipping + tax, coupon, couponError,
           freeShippingFromPaise: FREE_SHIPPING_FROM, gstPercent: GST_RATE * 100 };
}

module.exports = { price, COUPONS, FREE_SHIPPING_FROM, SHIPPING_FEE, GST_RATE };
