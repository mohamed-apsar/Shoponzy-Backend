import mongoose from "mongoose";
import { Order, Payment } from "../models/commerce.js";
import { round2 } from "../models/shared.js";
import { escapeRegex } from "../validators/common.js";

/* Every figure here comes from Payment records, whose statuses are only set from verified sources:
   the signed checkout callback re-checked against Razorpay, signed webhooks, or a gateway fetch. */

const { ObjectId } = mongoose.Types;

// The status an admin sees, and which stored payment statuses it covers.
export const DISPLAY_STATUSES = {
  success: ["captured"],
  failed: ["failed"],
  pending: ["created", "authorized", "pending"],
  refunded: ["refunded"],
  partially_refunded: ["partially_refunded"],
};
export const displayStatus = (s) => Object.keys(DISPLAY_STATUSES).find((k) => DISPLAY_STATUSES[k].includes(s)) || "pending";
// Money actually received: captured payments, including ones later (partly) refunded.
const RECEIVED = ["captured", "refunded", "partially_refunded"];

export const PAYMENT_METHODS = ["upi", "card", "netbanking", "wallet", "emi", "paylater", "cod"];

/* Builds the Payment filter. `withStatus: false` gives the same scope without the status filter (for the cards). */
export async function transactionFilter({ status, method, provider, q, from, to }, { withStatus = true } = {}) {
  const filter = {};
  if (withStatus && status) filter.status = { $in: DISPLAY_STATUSES[status] || [status] };
  if (provider) filter.provider = provider;
  if (method === "cod") filter.provider = "cod";
  else if (method) filter.method = method;
  if (from || to) filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    const orders = await Order.find({ $or: [{ orderNumber: rx }, { "contact.name": rx }, { "contact.email": rx }, { "contact.phone": rx }] }).select("_id").limit(1000).lean();
    filter.$or = [
      { providerPaymentId: rx }, { providerOrderId: rx }, { "refunds.refundId": rx },
      { order: { $in: orders.map((o) => o._id) } },
      ...(ObjectId.isValid(q) && /^[a-f\d]{24}$/i.test(q) ? [{ _id: new ObjectId(q) }] : []),
    ];
  }
  return filter;
}

const SORTS = { newest: { createdAt: -1 }, oldest: { createdAt: 1 }, amount_high: { amount: -1, createdAt: -1 }, amount_low: { amount: 1, createdAt: -1 } };

export function transactionView(p) {
  const order = p.order && typeof p.order === "object" ? p.order : null;
  const refunds = (p.refunds || []).map((r) => ({
    refundId: r.refundId, amount: r.amount, status: r.status, initiatedAt: r.at, processedAt: r.processedAt || null,
    failedAt: r.failedAt || null, failureReason: r.failureReason || "", reason: r.reason || "", manual: Boolean(r.manual),
    by: r.by && typeof r.by === "object" ? { id: String(r.by._id), name: r.by.name } : null,
    returnRequest: r.returnRequest && typeof r.returnRequest === "object" ? { id: String(r.returnRequest._id), returnNumber: r.returnRequest.returnNumber } : r.returnRequest ? { id: String(r.returnRequest) } : null,
  }));
  return {
    id: String(p._id),
    provider: p.provider,
    razorpayPaymentId: p.providerPaymentId || null,
    razorpayOrderId: p.providerOrderId || null,
    order: order ? { id: String(order._id), orderNumber: order.orderNumber, status: order.status, total: order.total, paymentStatus: order.paymentStatus } : null,
    customer: order?.contact ? { name: order.contact.name, email: order.contact.email || "", phone: order.contact.phone } : null,
    amount: p.amount, currency: p.currency || "INR",
    method: p.provider === "cod" ? "cod" : p.method || null,
    methodDetails: p.methodDetails || null,
    status: displayStatus(p.status), rawStatus: p.status,
    failure: p.status === "failed" ? {
      code: p.errorCode || "", description: p.errorDescription || "", source: p.errorSource || "", step: p.errorStep || "", reason: p.errorReason || "",
    } : null,
    refundedAmount: p.refundedAmount || 0,
    refundStatus: refunds.length ? (refunds.some((r) => r.status === "failed") ? "failed" : refunds.some((r) => r.status === "pending") ? "pending" : "processed") : null,
    refunds,
    capturedAt: p.capturedAt || null,
    createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
}

const withOrder = (q) => q.populate("order", "orderNumber contact total status paymentStatus").populate("refunds.by", "name").populate("refunds.returnRequest", "returnNumber");

export async function listTransactions(query, { skip, limit }) {
  const filter = await transactionFilter(query);
  const [items, total] = await Promise.all([
    withOrder(Payment.find(filter).sort(SORTS[query.sort] || SORTS.newest).skip(skip).limit(limit)).lean(),
    Payment.countDocuments(filter),
  ]);
  return { items: items.map(transactionView), total };
}

export async function getTransaction(id) {
  const p = await withOrder(Payment.findById(id)).lean();
  return p && transactionView(p);
}

/* Summary cards for the current scope (search, method and dates apply; the status filter doesn't, so the
   cards always show the full success / failed / pending split). */
export async function transactionSummary(query) {
  const filter = await transactionFilter(query, { withStatus: false });
  const [byStatus, refunds, methods] = await Promise.all([
    Payment.aggregate([{ $match: filter }, { $group: { _id: "$status", n: { $sum: 1 }, amount: { $sum: "$amount" } } }]),
    Payment.aggregate([
      { $match: filter }, { $unwind: "$refunds" },
      { $group: { _id: "$refunds.status", n: { $sum: 1 }, amount: { $sum: "$refunds.amount" } } },
    ]),
    // Per payment method (COD counted as its own method; attempts with no method yet are "unknown").
    Payment.aggregate([
      { $match: filter },
      { $group: {
        _id: { $cond: [{ $eq: ["$provider", "cod"] }, "cod", { $ifNull: ["$method", "unknown"] }] },
        total: { $sum: 1 },
        successful: { $sum: { $cond: [{ $in: ["$status", RECEIVED] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
        amount: { $sum: { $cond: [{ $in: ["$status", RECEIVED] }, "$amount", 0] } },
        refunded: { $sum: "$refundedAmount" },
      } },
      { $sort: { amount: -1, total: -1 } },
    ]),
  ]);
  const count = (statuses) => byStatus.filter((s) => statuses.includes(s._id)).reduce((t, s) => t + s.n, 0);
  const sum = (statuses) => round2(byStatus.filter((s) => statuses.includes(s._id)).reduce((t, s) => t + s.amount, 0));
  const refund = (status) => refunds.find((r) => r._id === status) || { n: 0, amount: 0 };
  return {
    totalTransactions: byStatus.reduce((t, s) => t + s.n, 0),
    successful: count(RECEIVED),
    failed: count(DISPLAY_STATUSES.failed),
    pending: count(DISPLAY_STATUSES.pending),
    refundedTransactions: count(["refunded", "partially_refunded"]),
    totalAmount: sum(RECEIVED),
    // Refunds Razorpay has confirmed as processed; initiated-but-pending refunds are reported separately.
    totalRefunded: round2(refund("processed").amount),
    refundsPending: { count: refund("pending").n, amount: round2(refund("pending").amount) },
    refundsFailed: { count: refund("failed").n, amount: round2(refund("failed").amount) },
    byMethod: methods.map((m) => ({
      method: m._id, total: m.total, successful: m.successful, failed: m.failed,
      successRate: m.successful + m.failed ? Math.round((m.successful / (m.successful + m.failed)) * 100) : null,
      amount: round2(m.amount), refunded: round2(m.refunded),
    })),
  };
}

export async function transactionsCursor(query, max) {
  const filter = await transactionFilter(query);
  return withOrder(Payment.find(filter).sort(SORTS[query.sort] || SORTS.newest).limit(max)).lean().cursor();
}

/* ---------- Refund tracking: one row per refund, across all payments ---------- */
export async function listRefunds({ status, q, from, to }, { skip, limit }) {
  const pre = { "refunds.0": { $exists: true } };
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    const orders = await Order.find({ $or: [{ orderNumber: rx }, { "contact.name": rx }, { "contact.email": rx }] }).select("_id").limit(1000).lean();
    pre.$or = [{ providerPaymentId: rx }, { "refunds.refundId": rx }, { order: { $in: orders.map((o) => o._id) } }];
  }
  const post = {};
  if (status) post["refunds.status"] = status;
  if (from || to) post["refunds.at"] = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const [result] = await Payment.aggregate([
    { $match: pre }, { $unwind: "$refunds" }, { $match: post },
    { $facet: {
      total: [{ $count: "n" }],
      items: [
        { $sort: { "refunds.at": -1 } }, { $skip: skip }, { $limit: limit },
        { $lookup: { from: "orders", localField: "order", foreignField: "_id", as: "order", pipeline: [{ $project: { orderNumber: 1, contact: 1, total: 1, refundedAmount: 1 } }] } },
        { $lookup: { from: "returnrequests", localField: "refunds.returnRequest", foreignField: "_id", as: "rr", pipeline: [{ $project: { returnNumber: 1 } }] } },
        { $lookup: { from: "users", localField: "refunds.by", foreignField: "_id", as: "by", pipeline: [{ $project: { name: 1 } }] } },
      ],
    } },
  ]);
  const items = result.items.map((p) => {
    const order = p.order[0];
    const r = p.refunds;
    return {
      refundId: r.refundId, amount: r.amount, status: r.status, initiatedAt: r.at, processedAt: r.processedAt || null,
      failedAt: r.failedAt || null, failureReason: r.failureReason || "", reason: r.reason || "", manual: Boolean(r.manual),
      by: p.by[0] ? { id: String(p.by[0]._id), name: p.by[0].name } : null,
      transactionId: String(p._id), razorpayPaymentId: p.providerPaymentId || null, provider: p.provider,
      order: order ? { id: String(order._id), orderNumber: order.orderNumber, total: order.total } : null,
      customer: order?.contact ? { name: order.contact.name, email: order.contact.email || "" } : null,
      returnRequest: p.rr[0] ? { id: String(p.rr[0]._id), returnNumber: p.rr[0].returnNumber } : null,
    };
  });
  return { items, total: result.total[0]?.n || 0 };
}
