import { Order, Payment, ReturnRequest } from "../../models/commerce.js";
import { audit } from "../../models/AuditLog.js";
import * as orders from "../../services/orderService.js";
import { sendInvoice } from "../../services/invoiceService.js";
import { AppError } from "../../utils/AppError.js";
import { ok, paginate } from "../../utils/respond.js";
import { escapeRegex } from "../../validators/common.js";
import * as transactions from "../../services/transactionService.js";
import { MAX_EXPORT_ROWS, csvDate, sendCsv } from "../../utils/csv.js";

export async function listOrders(req, res) {
  const { q, status, paymentStatus, paymentMethod, attention, from, to, customer, ...pageQ } = req.valid.query;
  const filter = {};
  const visibility = !status && !attention ? { $nor: [{ paymentMethod: "razorpay", paymentStatus: { $in: ["pending", "failed"] }, status: { $in: ["pending_payment", "cancelled"] }, refundRequired: { $ne: true }, needsAttention: null }] } : {};
  Object.assign(filter, visibility);
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
    Order.aggregate([{ $match: visibility }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  ok(res, items.map((order) => ({ ...order.toJSON(), allowedTransitions: orders.TRANSITIONS[order.status] })), { ...meta(total), statusCounts: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
}

async function loadOrder(id) {
  const order = await Order.findById(id).populate("user", "name email phone").populate("history.by", "name");
  if (!order) throw AppError.notFound("Order not found.");
  return order;
}

export async function getOrder(req, res) {
  const order = await loadOrder(req.params.id);
  const [payments, returnRequests] = await Promise.all([
    Payment.find({ order: order._id }).sort({ createdAt: 1 }),
    ReturnRequest.find({ order: order._id }).sort({ createdAt: -1 }).select("returnNumber status refund.status refund.amount createdAt items.qty").lean(),
  ]);
  ok(res, { order, payments, returns: returnRequests.map((r) => ({ id: String(r._id), returnNumber: r.returnNumber, status: r.status, refundStatus: r.refund?.status, refundAmount: r.refund?.amount ?? null, quantity: r.items.reduce((s, i) => s + i.qty, 0), createdAt: r.createdAt })), allowedTransitions: orders.TRANSITIONS[order.status] });
}

export async function updateStatus(req, res) {
  const order = await orders.updateStatus(req.params.id, req.valid.body, req.auth.user);
  ok(res, { order, allowedTransitions: orders.TRANSITIONS[order.status] });
}

export async function updateFulfilment(req, res) {
  const order = await loadOrder(req.params.id);
  const { notes, ...fulfilment } = req.valid.body;
  for (const [key, value] of Object.entries(fulfilment)) order.set(`fulfilment.${key}`, value);
  order.set("fulfilment.trackingUpdatedAt", new Date());
  if (notes !== undefined) order.notes = notes;
  await order.save();
  await audit("order.fulfilment_updated", { actor: req.auth.user._id, entity: "Order", entityId: order._id, ip: req.ip });
  ok(res, { order });
}

export async function cancel(req, res) {
  const order = await orders.cancelOrder(req.params.id, { reason: req.valid.body.reason || "Cancelled by store", by: req.auth.user._id, force: req.valid.body.force });
  await audit("order.cancelled", { actor: req.auth.user._id, entity: "Order", entityId: order._id, ip: req.ip });
  ok(res, { order });
}

export const refund = async (req, res) => ok(res, { order: await orders.refundOrder(req.params.id, req.valid.body, req.auth.user) });

export async function invoice(req, res) {
  return sendInvoice(res, await loadOrder(req.params.id));
}

/* ---------- Transactions & payments ---------- */
export async function listTransactions(req, res) {
  const { skip, limit, meta } = paginate(req.valid.query);
  const [{ items, total }, summary] = await Promise.all([
    transactions.listTransactions(req.valid.query, { skip, limit }),
    transactions.transactionSummary(req.valid.query),
  ]);
  ok(res, items, { ...meta(total), summary });
}

export const transactionSummary = async (req, res) => ok(res, await transactions.transactionSummary(req.valid.query));

export async function getTransaction(req, res) {
  const t = await transactions.getTransaction(req.params.id);
  if (!t) throw AppError.notFound("Transaction not found.");
  ok(res, t);
}

export async function exportTransactions(req, res) {
  const rows = [["transaction_id", "razorpay_payment_id", "razorpay_order_id", "order_id", "customer", "customer_email", "amount", "currency", "payment_method", "payment_status", "refund_amount", "refund_status", "transaction_date"]];
  for await (const p of await transactions.transactionsCursor(req.valid.query, MAX_EXPORT_ROWS)) {
    const t = transactions.transactionView(p);
    rows.push([t.id, t.razorpayPaymentId, t.razorpayOrderId, t.order?.orderNumber, t.customer?.name, t.customer?.email, t.amount, t.currency,
      t.method, t.status, t.refundedAmount, t.refundStatus || "", csvDate(t.createdAt)]);
  }
  await audit("transactions.exported", { actor: req.auth.user._id, entity: "Payment", ip: req.ip, meta: { rows: rows.length - 1, filters: req.valid.query } });
  sendCsv(res, `shoponzy-transactions-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}

export async function listRefunds(req, res) {
  const { skip, limit, meta } = paginate(req.valid.query);
  const { items, total } = await transactions.listRefunds(req.valid.query, { skip, limit });
  ok(res, items, meta(total));
}

export async function syncRefund(req, res) {
  const result = await orders.syncRefund(req.params.id, req.params.refundId);
  await audit("refund.synced", { actor: req.auth.user._id, entity: "Payment", entityId: req.params.id, ip: req.ip, meta: { refundId: req.params.refundId, ...result } });
  ok(res, { ...result, transaction: await transactions.getTransaction(req.params.id) });
}

export async function exportRefunds(req, res) {
  const { items } = await transactions.listRefunds(req.valid.query, { skip: 0, limit: MAX_EXPORT_ROWS });
  const rows = [["refund_id", "transaction_id", "razorpay_payment_id", "order_id", "customer", "customer_email", "amount", "refund_status", "manual_cod", "initiated_at", "completed_at", "failed_at", "failure_reason", "reason", "issued_by", "return_id"]];
  for (const r of items) {
    rows.push([r.refundId, r.transactionId, r.razorpayPaymentId, r.order?.orderNumber, r.customer?.name, r.customer?.email, r.amount, r.status, r.manual ? "yes" : "no",
      csvDate(r.initiatedAt), csvDate(r.processedAt), csvDate(r.failedAt), r.failureReason, r.reason, r.by?.name, r.returnRequest?.returnNumber]);
  }
  await audit("refunds.exported", { actor: req.auth.user._id, entity: "Payment", ip: req.ip, meta: { rows: items.length, filters: req.valid.query } });
  sendCsv(res, `shoponzy-refunds-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}

/* Payment method breakdown (same scope as the Payment Methods page). */
export async function exportMethods(req, res) {
  const { byMethod } = await transactions.transactionSummary(req.valid.query);
  const rows = [["payment_method", "transactions", "successful", "failed", "success_rate_pct", "amount_received", "amount_refunded"]];
  for (const m of byMethod) rows.push([m.method === "unknown" ? "not chosen yet" : m.method, m.total, m.successful, m.failed, m.successRate ?? "", m.amount, m.refunded]);
  await audit("transactions.methods_exported", { actor: req.auth.user._id, entity: "Payment", ip: req.ip, meta: { filters: req.valid.query } });
  sendCsv(res, `shoponzy-payment-methods-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}
