/** PDF invoice generator (pdfkit). Uses "Rs." because the built-in PDF fonts have no rupee glyph. */
const PDFDocument = require('pdfkit');

const rs = paise => 'Rs. ' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function renderInvoice(order, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Invoice ${order.invoiceNo}`, Author: 'ShopSphere' } });
  doc.pipe(stream);
  const left = 48, right = 547;

  doc.fillColor('#4f46e5').font('Helvetica-Bold').fontSize(22).text('ShopSphere', left, 48);
  doc.fillColor('#6b7280').font('Helvetica').fontSize(9).text('Multi-vendor marketplace', left, 74);
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(16).text('TAX INVOICE', 350, 48, { width: right - 350, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#374151')
    .text(`Invoice no: ${order.invoiceNo}`, 350, 70, { width: right - 350, align: 'right' })
    .text(`Order no: #${order.id}`, 350, 83, { width: right - 350, align: 'right' })
    .text(`Date: ${new Date(order.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`, 350, 96, { width: right - 350, align: 'right' });

  doc.moveTo(left, 118).lineTo(right, 118).strokeColor('#e5e7eb').stroke();

  const a = order.address;
  doc.fillColor('#6b7280').font('Helvetica-Bold').fontSize(8).text('BILL TO / SHIP TO', left, 130);
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(10).text(a.name, left, 143);
  doc.font('Helvetica').fontSize(9).fillColor('#374151')
    .text(`${a.line1}`, left, 157).text(`${a.city}, ${a.state} - ${a.pin}`, left, 170).text(`Phone: ${a.phone}`, left, 183);

  doc.fillColor('#6b7280').font('Helvetica-Bold').fontSize(8).text('PAYMENT', 350, 130);
  const method = { COD: 'Cash on delivery', CARD_TEST: 'Card (test mode)', UPI_TEST: 'UPI (test mode)' }[order.paymentMethod] || order.paymentMethod;
  doc.fillColor('#374151').font('Helvetica').fontSize(9)
    .text(`Method: ${method}`, 350, 143).text(`Status: ${order.paymentStatus}`, 350, 157);
  if (order.transactionId) doc.text(`Ref: ${order.transactionId}`, 350, 170);

  // items table
  let y = 215;
  const cols = { n: left, vendor: 250, qty: 360, price: 410, total: 480 };
  doc.rect(left, y - 6, right - left, 22).fill('#f3f4f6');
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(9)
    .text('Item', cols.n + 6, y).text('Sold by', cols.vendor, y).text('Qty', cols.qty, y, { width: 35, align: 'right' })
    .text('Rate', cols.price, y, { width: 60, align: 'right' }).text('Amount', cols.total, y, { width: right - cols.total - 6, align: 'right' });
  y += 24;
  doc.font('Helvetica').fillColor('#374151');
  for (const it of order.items) {
    if (y > 700) { doc.addPage(); y = 60; }
    const cancelled = it.status === 'CANCELLED';
    doc.fillColor(cancelled ? '#9ca3af' : '#374151').fontSize(9)
      .text(it.name + (cancelled ? ' (cancelled)' : ''), cols.n + 6, y, { width: 190 })
      .text(it.vendorName, cols.vendor, y, { width: 105 })
      .text(String(it.qty), cols.qty, y, { width: 35, align: 'right' })
      .text(rs(it.unitPricePaise), cols.price, y, { width: 60, align: 'right' })
      .text(cancelled ? '-' : rs(it.unitPricePaise * it.qty), cols.total, y, { width: right - cols.total - 6, align: 'right' });
    y += Math.max(18, doc.heightOfString(it.name, { width: 190 }) + 8);
    doc.moveTo(left, y - 4).lineTo(right, y - 4).strokeColor('#f3f4f6').stroke();
  }

  y += 10;
  const row = (label, value, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9).fillColor(bold ? '#111827' : '#374151')
      .text(label, 330, y, { width: 120 }).text(value, 440, y, { width: right - 440, align: 'right' });
    y += bold ? 22 : 16;
  };
  row('Subtotal', rs(order.subtotalPaise));
  if (order.discountPaise) row(`Discount${order.couponCode ? ` (${order.couponCode})` : ''}`, '- ' + rs(order.discountPaise));
  row('Shipping', order.shippingPaise ? rs(order.shippingPaise) : 'FREE');
  row('GST (18%)', rs(order.taxPaise));
  doc.moveTo(330, y - 2).lineTo(right, y - 2).strokeColor('#d1d5db').stroke();
  y += 4;
  row('Total', rs(order.totalPaise), true);

  doc.fillColor('#9ca3af').font('Helvetica').fontSize(8)
    .text('This is a computer-generated invoice for a demo marketplace project. Payments are simulated (test mode).', left, 770, { width: right - left, align: 'center' });
  doc.end();
}

module.exports = { renderInvoice };
