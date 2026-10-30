import { Order, Payment } from "../../models/commerce.js";
import { audit } from "../../models/AuditLog.js";
import * as orders from "../../services/orderService.js";
import { getSection } from "../../services/settingsService.js";
import { AppError } from "../../utils/AppError.js";
import { ok, paginate } from "../../utils/respond.js";
import { escapeRegex } from "../../validators/common.js";

export async function listOrders(req, res) {
  const { q, status, paymentStatus, paymentMethod, attention, from, to, customer, ...pageQ } = req.valid.query;
  const filter = {};
  if (status) filter.status = status;
  if (paymentStatus) filter.paymentStatus = paymentStatus;
  if (paymentMethod) filter.paymentMethod = paymentMethod;
  if (customer) filter.user = customer;
  if (attention) filter.$or = [{ refundRequired: true }, { needsAttention: { $ne: null } }];
  if (from || to) filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$and = [{ $or: [{ orderNumber: rx }, { "contact.name": rx }, { "contact.phone": rx }, { "contact.email": rx }] }];
  }
  const { skip, limit, meta } = paginate(pageQ);
  const [items, total, counts] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).select("-history"),
    Order.countDocuments(filter),
    Order.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  ok(res, items, { ...meta(total), statusCounts: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
}

async function loadOrder(id) {
  const order = await Order.findById(id).populate("user", "name email phone").populate("history.by", "name");
  if (!order) throw AppError.notFound("Order not found.");
  return order;
}

export async function getOrder(req, res) {
  const order = await loadOrder(req.params.id);
  const payments = await Payment.find({ order: order._id }).sort({ createdAt: 1 });
  ok(res, { order, payments, allowedTransitions: orders.TRANSITIONS[order.status] });
}

export async function updateStatus(req, res) {
  const order = await orders.updateStatus(req.params.id, req.valid.body, req.auth.user);
  ok(res, { order, allowedTransitions: orders.TRANSITIONS[order.status] });
}

export async function updateFulfilment(req, res) {
  const order = await loadOrder(req.params.id);
  const { notes, ...fulfilment } = req.valid.body;
  order.fulfilment = { ...order.fulfilment?.toObject?.(), ...fulfilment };
  if (notes !== undefined) order.notes = notes;
  await order.save();
  await audit("order.fulfilment_updated", { actor: req.auth.user._id, entity: "Order", entityId: order._id, ip: req.ip });
  ok(res, { order });
}

export async function cancel(req, res) {
  const order = await orders.cancelOrder(req.params.id, { reason: req.valid.body.reason || "Cancelled by store", by: req.auth.user._id });
  await audit("order.cancelled", { actor: req.auth.user._id, entity: "Order", entityId: order._id, ip: req.ip });
  ok(res, { order });
}

export const refund = async (req, res) => ok(res, { order: await orders.refundOrder(req.params.id, req.valid.body, req.auth.user) });

/* Printable invoice (HTML). All values are escaped. */
export async function invoice(req, res) {
  const order = await loadOrder(req.params.id);
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
${row("Subtotal", m(order.subtotal))}${row(`Coupon ${e(order.couponCode)}`, order.couponDiscount ? "−" + m(order.couponDiscount) : "")}${row("Prepaid discount", order.prepaidDiscount ? "−" + m(order.prepaidDiscount) : "")}${row("Delivery", order.shippingFee ? m(order.shippingFee) : "Free")}
<tr><td colspan="4" class="r"><b>Total (incl. taxes)</b></td><td class="r"><b>${m(order.total)}</b></td></tr>${row("Refunded", order.refundedAmount ? "−" + m(order.refundedAmount) : "")}</tbody></table>
<p class="muted">Thank you for shopping with ${e(general.websiteName)}.</p></body></html>`;
  // The invoice runs a print button, so it gets its own permissive-enough CSP instead of the API's default-src 'none'.
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'").type("html").send(html);
}

/* ---------- Transactions ---------- */
export async function listTransactions(req, res) {
  const { status, provider, q, from, to, ...pageQ } = req.valid.query;
  const filter = {};
  if (status) filter.status = status;
  if (provider) filter.provider = provider;
  if (from || to) filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    const matching = await Order.find({ orderNumber: rx }).select("_id").lean();
    filter.$or = [{ providerPaymentId: rx }, { providerOrderId: rx }, { order: { $in: matching.map((o) => o._id) } }];
  }
  const { skip, limit, meta } = paginate(pageQ);
  const [items, total, sums] = await Promise.all([
    Payment.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("order", "orderNumber contact.name total status"),
    Payment.countDocuments(filter),
    Payment.aggregate([{ $match: filter }, { $group: { _id: "$status", amount: { $sum: "$amount" }, refunded: { $sum: "$refundedAmount" }, n: { $sum: 1 } } }]),
  ]);
  ok(res, items, { ...meta(total), totals: Object.fromEntries(sums.map((s) => [s._id, { count: s.n, amount: s.amount, refunded: s.refunded }])) });
}
