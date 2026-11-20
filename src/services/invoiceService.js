import { getSection } from "./settingsService.js";

/* Printable invoice (HTML). All values are escaped. */
export async function sendInvoice(res, order) {
  const [general, contact] = await Promise.all([getSection("general"), getSection("contact")]);
  const e = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const m = (n) => "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const a = order.shippingAddress || {};
  const row = (label, v) => (v ? `<tr><td colspan="4" class="r">${label}</td><td class="r">${v}</td></tr>` : "");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invoice ${e(order.orderNumber)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#111;max-width:760px;margin:24px auto;padding:0 16px}h1{font-size:22px;margin:0}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left}.r{text-align:right}.grid{display:flex;justify-content:space-between;gap:24px;margin-top:16px}.muted{color:#666}@media print{button{display:none}}</style></head>
<body><button onclick="print()">Print</button><div class="grid"><div><h1>${e(general.websiteName)}</h1><div class="muted">${e(contact.address)}<br>${e(contact.email)} · ${e(contact.phone)}</div></div>
<div class="r"><b>Invoice / Order ${e(order.orderNumber)}</b><br>${e(new Date(order.placedAt || order.createdAt).toLocaleDateString("en-IN"))}<br>Payment: ${order.paymentMethod === "cod" ? "Cash on delivery" : "Online (Razorpay)"} — ${e(order.paymentStatus)}</div></div>
<div class="grid"><div><b>Deliver to</b><br>${e(a.name)}<br>${e(a.line1)}${a.line2 ? `<br>${e(a.line2)}` : ""}<br>${e(a.city)}, ${e(a.state)} ${e(a.pincode)}<br>${e(a.phone)}</div><div class="r"><b>Customer</b><br>${e(order.contact.name)}<br>${e(order.contact.phone)}<br>${e(order.contact.email)}</div></div>
<table><thead><tr><th>Item</th><th>Variant</th><th class="r">Price</th><th class="r">Qty</th><th class="r">Total</th></tr></thead><tbody>
${order.items.map((i) => `<tr><td>${e(i.name)}<br><small class="muted">${e(i.sku)}</small></td><td>${e([i.color, i.size].filter(Boolean).join(" / "))}</td><td class="r">${m(i.price)}</td><td class="r">${i.qty}</td><td class="r">${m(i.lineTotal)}</td></tr>`).join("")}
${row("Subtotal", m(order.subtotal))}${row(`Coupon ${e(order.couponCode)}`, order.couponDiscount ? "−" + m(order.couponDiscount) : "")}${row("Account discount", order.accountDiscount ? "−" + m(order.accountDiscount) : "")}${row("Prepaid discount", order.prepaidDiscount ? "−" + m(order.prepaidDiscount) : "")}${row("Delivery", order.shippingFee ? m(order.shippingFee) : "Free")}
<tr><td colspan="4" class="r"><b>Total (incl. taxes)</b></td><td class="r"><b>${m(order.total)}</b></td></tr>${row("Refunded", order.refundedAmount ? "−" + m(order.refundedAmount) : "")}</tbody></table>
<p class="muted">Thank you for shopping with ${e(general.websiteName)}.</p></body></html>`;
  // The invoice runs a print button, so it gets its own permissive-enough CSP instead of the API's default-src 'none'.
  res.set("Cache-Control", "private, no-store");
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'").type("html").send(html);
}
