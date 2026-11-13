import mongoose from "mongoose";
import { InventoryMovement, Order, Payment, ReturnRequest, Upload, nextSequence } from "../models/commerce.js";
import { round2 } from "../models/shared.js";
import { audit } from "../models/AuditLog.js";
import { AppError } from "../utils/AppError.js";
import { inTransaction } from "../utils/transaction.js";
import { escapeRegex } from "../validators/common.js";
import { getSection, updateSection } from "./settingsService.js";
import { issueRefund, restockVariant, updateStatus as updateOrderStatus } from "./orderService.js";
import { sendReturnEmail } from "./notifyService.js";

/* Return workflow
   requested → approved → (pickup_scheduled → in_transit →) received → inspected → completed
   requested → rejected;  requested / approved / pickup_scheduled → cancelled
   - Stock only goes back at inspection, for the units the inspector marks as restockable.
   - A refund can only be issued once the return is inspected, and only for what the database says the
     returned items were paid for. Its status follows Razorpay (response, webhook or sync), never the UI. */

const { ObjectId } = mongoose.Types;

const ACTIVE = { status: { $nin: ["rejected", "cancelled"] } };
export const STATUS_FLOW = {
  requested: ["approved", "rejected", "cancelled"],
  approved: ["pickup_scheduled", "in_transit", "received", "cancelled"],
  pickup_scheduled: ["in_transit", "received", "cancelled"],
  in_transit: ["received"],
  received: ["inspected"],
  inspected: ["completed"],
  rejected: [], completed: [], cancelled: [],
};
// Statuses an admin sets through the generic status endpoint (others have their own actions).
export const MANUAL_STATUSES = ["pickup_scheduled", "in_transit", "received", "completed", "cancelled"];
const PAID = ["paid", "partially_refunded"];

/* ---------- Return reasons (admin-configurable) ---------- */
export async function getReturnReasons() {
  return (await getSection("returns")).reasons;
}
const reasonLabelOf = (reasons, code) => reasons.find((r) => r.code === code)?.label || code.replace(/_/g, " ");
const slugCode = (label) => label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

/* Replaces the reason list. New reasons get a code from their label; a reason already used by a return
   request can be renamed or disabled, but not removed (its requests would lose their reason). */
export async function updateReturnReasons(input, actor) {
  const current = await getReturnReasons();
  const seen = new Set();
  const taken = new Set([...current.map((c) => c.code), ...input.map((r) => r.code).filter(Boolean)]);
  const reasons = input.map((r) => {
    let code = r.code;
    if (!code) {
      // New reason: a fresh code that never reuses an existing one (that would relabel old requests).
      const base = slugCode(r.label).padEnd(2, "_") || "reason";
      code = base;
      for (let n = 2; taken.has(code); n++) code = `${base.slice(0, 36)}_${n}`;
      taken.add(code);
    }
    if (seen.has(code)) throw AppError.badRequest(`Two reasons share the code "${code}".`);
    seen.add(code);
    return { code, label: r.label, active: r.active, requiresComment: r.requiresComment };
  });
  const labels = reasons.map((r) => r.label.toLowerCase());
  if (new Set(labels).size !== labels.length) throw AppError.badRequest("Two reasons have the same name.");
  if (!reasons.some((r) => r.active)) throw AppError.badRequest("Keep at least one reason active so customers can request returns.");
  const removed = current.filter((c) => !seen.has(c.code)).map((c) => c.code);
  if (removed.length) {
    const used = await ReturnRequest.distinct("reason", { reason: { $in: removed } });
    if (used.length) throw AppError.conflict(`"${reasonLabelOf(current, used[0])}" is used by existing return requests. Disable it instead of deleting it.`);
  }
  await updateSection("returns", { reasons });
  await audit("returns.reasons_updated", { actor: actor._id, entity: "SiteSetting", entityId: "returns", meta: { codes: reasons.map((r) => r.code), removed } });
  return reasons;
}

/* Per-reason counts for the admin list of reasons. */
export async function reasonUsage() {
  const rows = await ReturnRequest.aggregate([{ $group: { _id: "$reason", n: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}

const deliveredAt = (order) => order.fulfilment?.deliveredAt
  || [...(order.history || [])].reverse().find((h) => h.status === "delivered")?.at || null;

/* What a customer may still return from an order, and until when. */
export async function returnEligibility(order) {
  const { returnDays } = await getSection("commerce");
  const delivered = deliveredAt(order);
  const until = delivered ? new Date(new Date(delivered).getTime() + returnDays * 86_400_000) : null;
  const taken = await ReturnRequest.aggregate([
    { $match: { order: order._id, ...ACTIVE } }, { $unwind: "$items" },
    { $group: { _id: "$items.variant", qty: { $sum: "$items.qty" } } },
  ]);
  const takenBy = new Map(taken.map((t) => [String(t._id), t.qty]));
  const items = order.items.map((it) => ({
    variant: String(it.variant), name: it.name, sku: it.sku, image: it.image, color: it.color, size: it.size,
    price: it.price, ordered: it.qty, returnable: Math.max(0, it.qty - (takenBy.get(String(it.variant)) || 0)),
  }));
  let reason = null;
  if (order.status !== "delivered") reason = "Returns can be requested once the order has been delivered.";
  else if (!returnDays) reason = "This store doesn't accept online return requests. Please contact us.";
  else if (until && until < new Date()) reason = `The ${returnDays}-day return window for this order has ended.`;
  else if (!items.some((i) => i.returnable > 0)) reason = "All items from this order are already in a return request.";
  const reasons = (await getReturnReasons()).filter((r) => r.active).map(({ code, label, requiresComment }) => ({ code, label, requiresComment }));
  return { eligible: !reason, reason, returnDays, returnBy: until, items, reasons };
}

/* The most that may be refunded for these items: what was paid for them, i.e. their line value minus a
   proportional share of the order's coupon and prepaid discounts. Delivery fees are not included. */
export function maxRefundFor(items, order) {
  const lines = items.reduce((s, i) => s + i.price * i.qty, 0);
  const discounts = (order.couponDiscount || 0) + (order.prepaidDiscount || 0);
  const share = order.subtotal > 0 ? (discounts * lines) / order.subtotal : 0;
  const remaining = round2((order.total || 0) - (order.refundedAmount || 0));
  return Math.max(0, Math.min(round2(lines - share), remaining));
}

const push = (rr, entry) => rr.history.push({ at: new Date(), ...entry });

/* ---------- Customer ---------- */
export async function createReturn({ order, owner, input, ip }) {
  const eligibility = await returnEligibility(order);
  if (!eligibility.eligible) throw new AppError(409, "RETURN_NOT_ALLOWED", eligibility.reason);
  const chosen = eligibility.reasons.find((r) => r.code === input.reason);
  if (!chosen) throw AppError.badRequest("Choose a return reason.", [{ path: "reason", message: "Choose a return reason." }]);
  if (chosen.requiresComment && (input.comments || "").trim().length < 5) {
    throw AppError.badRequest("Tell us a little about the reason for the return.", [{ path: "comments", message: "Tell us a little about the reason for the return." }]);
  }
  const byVariant = new Map(eligibility.items.map((i) => [i.variant, i]));
  const seen = new Set();
  const items = input.items.map(({ variantId, qty }) => {
    const line = byVariant.get(variantId);
    if (!line) throw AppError.badRequest("One of the items isn't part of this order.");
    if (seen.has(variantId)) throw AppError.badRequest("Each item can be listed once.");
    seen.add(variantId);
    if (qty > line.returnable) throw AppError.badRequest(`You can return at most ${line.returnable} of ${line.name}.`);
    const src = order.items.find((it) => String(it.variant) === variantId);
    return { product: src.product, variant: src.variant, sku: src.sku, name: src.name, image: src.image, color: src.color, size: src.size, price: src.price, qty };
  });

  // Photos must have been uploaded through the return-evidence endpoint.
  const evidence = [];
  for (const ref of input.evidence || []) {
    const up = await Upload.findOne({ publicId: ref.publicId, kind: "returnEvidence" }).lean();
    if (!up) throw AppError.badRequest("A photo couldn't be found. Please upload it again.");
    evidence.push({ url: up.url, publicId: up.publicId, alt: "Return photo", width: up.width, height: up.height });
  }

  const seq = await nextSequence("return");
  const rr = await ReturnRequest.create({
    returnNumber: `RT${100000 + seq}`, order: order._id, orderNumber: order.orderNumber,
    user: order.user || undefined, guestId: order.guestId || undefined,
    contact: { name: order.contact.name, email: order.contact.email, phone: order.contact.phone },
    items, reason: chosen.code, reasonLabel: chosen.label, comments: input.comments || "", evidence,
    history: [{ status: "requested", note: "Return requested by customer", by: owner.userId || undefined, at: new Date() }],
  });
  await Order.updateOne({ _id: order._id }, { $push: { history: { status: order.status, note: `Return ${rr.returnNumber} requested`, at: new Date() } } });
  await audit("return.requested", { actor: owner.userId, entity: "ReturnRequest", entityId: rr._id, ip, meta: { returnNumber: rr.returnNumber, orderNumber: order.orderNumber, items: items.length } });
  return rr;
}

export async function cancelByCustomer(rr, owner) {
  const updated = await ReturnRequest.findOneAndUpdate(
    { _id: rr._id, status: "requested" },
    { $set: { status: "cancelled" }, $push: { history: { status: "cancelled", note: "Cancelled by customer", by: owner.userId || undefined, at: new Date() } } },
    { new: true },
  );
  if (!updated) throw new AppError(409, "INVALID_TRANSITION", "This return can no longer be cancelled online.");
  await audit("return.cancelled", { actor: owner.userId, entity: "ReturnRequest", entityId: rr._id, meta: { by: "customer" } });
  return updated;
}

export function customerReturnView(r) {
  const o = typeof r.toJSON === "function" ? r.toJSON() : r;
  return {
    id: o.id || String(o._id), returnNumber: o.returnNumber, orderNumber: o.orderNumber, status: o.status, reason: o.reason, reasonLabel: o.reasonLabel || o.reason, comments: o.comments,
    items: o.items.map(({ name, sku, image, color, size, qty, price }) => ({ name, sku, image, color, size, qty, price })),
    evidence: (o.evidence || []).map((e) => ({ url: e.url })),
    rejectionReason: o.status === "rejected" ? o.rejectionReason : "",
    refund: { status: o.refund?.status || "not_applicable", amount: o.refund?.amount ?? null, completedAt: o.refund?.completedAt || null },
    createdAt: o.createdAt, updatedAt: o.updatedAt,
    history: (o.history || []).map(({ status, refundStatus, at }) => ({ status, refundStatus, at })),
  };
}

/* ---------- Admin ---------- */
async function loadForAdmin(id) {
  const rr = await ReturnRequest.findById(id);
  if (!rr) throw AppError.notFound("Return request not found.");
  return rr;
}

/* Moves a return from one status to another only if nobody changed it meanwhile. */
async function transition(rr, to, actor, { note, set = {} } = {}) {
  if (!STATUS_FLOW[rr.status].includes(to)) throw new AppError(409, "INVALID_TRANSITION", `A ${rr.status.replace(/_/g, " ")} return can't be marked ${to.replace(/_/g, " ")}.`);
  const updated = await ReturnRequest.findOneAndUpdate(
    { _id: rr._id, status: rr.status },
    { $set: { status: to, ...set }, $push: { history: { status: to, note, by: actor._id, at: new Date() } } },
    { new: true },
  );
  if (!updated) throw AppError.conflict("This return was updated by someone else. Refresh and try again.");
  await audit(`return.${to}`, { actor: actor._id, entity: "ReturnRequest", entityId: rr._id, meta: { returnNumber: rr.returnNumber, from: rr.status, note } });
  return updated;
}

export async function approve(id, { note }, actor) {
  const rr = await loadForAdmin(id);
  const order = await Order.findById(rr.order).lean();
  const paid = order && PAID.includes(order.paymentStatus);
  const updated = await transition(rr, "approved", actor, {
    note: note || "Return approved",
    set: {
      decidedBy: actor._id, decidedAt: new Date(), adminNote: note || rr.adminNote,
      // Approval only makes a refund due; it is issued after the items are received and inspected.
      "refund.status": paid ? "pending" : "not_applicable",
      "refund.amount": paid ? maxRefundFor(rr.items, order) : null,
    },
  });
  sendReturnEmail(updated, "approved");
  return updated;
}

export async function reject(id, { reason, note }, actor) {
  const rr = await loadForAdmin(id);
  const updated = await transition(rr, "rejected", actor, {
    note: `Rejected: ${reason}`,
    set: { decidedBy: actor._id, decidedAt: new Date(), rejectionReason: reason, adminNote: note || rr.adminNote, "refund.status": "not_applicable" },
  });
  sendReturnEmail(updated, "rejected");
  return updated;
}

export async function setStatus(id, { status, note, pickup }, actor) {
  const rr = await loadForAdmin(id);
  const set = {};
  if (pickup) set.pickup = { ...(rr.pickup?.toObject?.() || {}), ...pickup };
  if (status === "received") set.receivedAt = new Date();
  if (status === "cancelled" && rr.refund?.status && !["not_applicable", "pending"].includes(rr.refund.status)) {
    throw new AppError(409, "INVALID_TRANSITION", "A return with a refund in progress can't be cancelled.");
  }
  if (status === "cancelled") set["refund.status"] = "not_applicable";
  if (status === "completed") {
    if (["pending", "processing", "failed"].includes(rr.refund?.status)) {
      throw new AppError(409, "REFUND_OUTSTANDING", rr.refund.status === "processing"
        ? "The refund is still processing at Razorpay. Complete the return once it is confirmed."
        : "Issue the refund before completing this return.");
    }
    set.completedAt = new Date();
  }
  const updated = await transition(rr, status, actor, { note, set });
  if (status === "completed") await markOrderReturnedIfFullyReturned(updated, actor);
  return updated;
}

/* When every unit of a delivered order has come back through completed returns, the order itself becomes
   "returned". Stock was already handled at inspection, so the order's own restock is skipped. */
async function markOrderReturnedIfFullyReturned(rr, actor) {
  const order = await Order.findById(rr.order);
  if (!order || order.status !== "delivered") return;
  const done = await ReturnRequest.aggregate([
    { $match: { order: order._id, status: "completed" } }, { $unwind: "$items" },
    { $group: { _id: "$items.variant", qty: { $sum: "$items.qty" } } },
  ]);
  const back = new Map(done.map((d) => [String(d._id), d.qty]));
  if (order.items.every((it) => (back.get(String(it.variant)) || 0) >= it.qty)) {
    await updateOrderStatus(order._id, { status: "returned", note: `All items returned (${rr.returnNumber})`, restock: false }, actor);
  }
}

/* Records the inspection; restockable units go back into stock in the same transaction. */
export async function inspect(id, { items, notes }, actor) {
  const updated = await inTransaction(async (session) => {
    const rr = await ReturnRequest.findById(id).session(session);
    if (!rr) throw AppError.notFound("Return request not found.");
    if (rr.status !== "received") throw new AppError(409, "INVALID_TRANSITION", "Mark the return as received before inspecting it.");
    if (items.length !== rr.items.length) throw AppError.badRequest("Inspect every item in the return.");
    const moves = [];
    for (const [index, item] of rr.items.entries()) {
      const result = items.find((i) => i.index === index);
      if (!result) throw AppError.badRequest("Inspect every item in the return.");
      if (result.restockQty > item.qty) throw AppError.badRequest(`At most ${item.qty} of ${item.name} can be restocked.`);
      if (result.condition === "unsellable" && result.restockQty > 0) throw AppError.badRequest(`${item.name} is marked unsellable, so it can't be restocked.`);
      item.condition = result.condition;
      item.restockedQty = result.restockQty;
      if (result.restockQty > 0) {
        const res = await restockVariant({ product: item.product, variant: item.variant, qty: result.restockQty }, session);
        if (res) moves.push({ product: item.product, variant: item.variant, sku: item.sku, delta: result.restockQty, ...res, reason: "return", returnRequest: rr._id, order: rr.order, actor: actor._id, note: `Return ${rr.returnNumber} (${result.condition})` });
      }
    }
    if (moves.length) await InventoryMovement.insertMany(moves, { session });
    rr.status = "inspected";
    rr.inspectedAt = new Date();
    rr.inspectedBy = actor._id;
    rr.inspectionNotes = notes || "";
    const restocked = moves.reduce((s, m) => s + m.delta, 0);
    push(rr, { status: "inspected", note: `Inspected${restocked ? `; ${restocked} unit(s) restocked` : "; nothing restocked"}${notes ? ` · ${notes}` : ""}`, by: actor._id });
    await rr.save({ session });
    return rr;
  });
  await audit("return.inspected", { actor: actor._id, entity: "ReturnRequest", entityId: updated._id, meta: { returnNumber: updated.returnNumber, items: items.map(({ index, condition, restockQty }) => ({ index, condition, restockQty })) } });
  return updated;
}

/* Issues the refund for an inspected return through the existing order refund (Razorpay or manual COD). */
export async function refund(id, { amount, manualReference, note }, actor) {
  const rr = await loadForAdmin(id);
  if (!["inspected", "completed"].includes(rr.status)) throw new AppError(409, "NOT_REFUNDABLE", "Refunds are issued after the returned items have been received and inspected.");
  if (!["pending", "failed"].includes(rr.refund?.status)) {
    throw new AppError(409, "NOT_REFUNDABLE", rr.refund?.status === "not_applicable" ? "No refund is due for this return (the order wasn't paid)." : "A refund for this return has already been issued.");
  }
  const order = await Order.findById(rr.order).lean();
  const max = maxRefundFor(rr.items, order);
  const value = round2(amount ?? max);
  if (value <= 0 || value > max) throw AppError.badRequest(`The refund for this return must be between ₹0.01 and ₹${max}.`);
  if (order.paymentMethod !== "razorpay" && !manualReference) throw AppError.badRequest("Cash on delivery refunds are paid outside the system; enter the bank/UPI reference.");

  // Claim the refund (pending/failed → processing) so a second click can't issue another one.
  const previous = rr.refund.status;
  const claimed = await ReturnRequest.findOneAndUpdate(
    { _id: rr._id, "refund.status": previous },
    { $set: { "refund.status": "processing", "refund.by": actor._id, "refund.initiatedAt": new Date() } },
    { new: true },
  );
  if (!claimed) throw new AppError(409, "REFUND_IN_PROGRESS", "A refund for this return is already being processed.");

  let result;
  try {
    result = await issueRefund(rr.order, { amount: value, reason: `Return ${rr.returnNumber}${note ? `: ${note}` : ""}`, manualReference, returnRequest: rr._id }, actor);
  } catch (err) {
    // Nothing was refunded: put the return back so the refund can be retried. A gateway rejection is
    // recorded as a failed refund; anything else (validation, a refund already running) just reverts.
    const gatewayFailed = err?.code === "REFUND_FAILED";
    await ReturnRequest.updateOne({ _id: rr._id, "refund.status": "processing" }, gatewayFailed ? {
      $set: { "refund.status": "failed", "refund.failureReason": err.message, "refund.failedAt": new Date() },
      $push: { history: { refundStatus: "failed", note: `Refund attempt failed: ${err.message}`, by: actor._id, at: new Date() } },
    } : { $set: { "refund.status": previous } });
    throw err;
  }
  const { refund: r } = result;
  const completed = r.status === "processed";
  const failed = r.status === "failed";
  const status = completed ? "completed" : failed ? "failed" : "processing";
  const updated = await ReturnRequest.findByIdAndUpdate(rr._id, {
    $set: {
      "refund.status": status, "refund.amount": r.amount, "refund.refundId": r.refundId, "refund.payment": r.payment,
      "refund.providerPaymentId": r.providerPaymentId, ...(completed ? { "refund.completedAt": new Date() } : {}),
      "refund.failureReason": "",
    },
    $push: { history: { refundStatus: status, note: `Refund ₹${r.amount} ${completed ? "processed" : "initiated"} (${r.refundId})`, by: actor._id, at: new Date() } },
  }, { new: true });
  await audit("return.refunded", { actor: actor._id, entity: "ReturnRequest", entityId: rr._id, meta: { returnNumber: rr.returnNumber, amount: r.amount, refundId: r.refundId, status: r.status } });
  if (completed) sendReturnEmail(updated, "refunded");
  return updated;
}

/* ---------- Listing ---------- */
export async function returnFilter({ q, status, refundStatus, reason, from, to, view }) {
  const filter = {};
  if (reason) filter.reason = reason;
  if (status) filter.status = status;
  if (view === "approved") filter.status = { $in: ["approved", "pickup_scheduled", "in_transit", "received", "inspected", "completed"] };
  if (view === "open") filter.status = { $in: ["requested", "approved", "pickup_scheduled", "in_transit", "received", "inspected"] };
  if (refundStatus) filter["refund.status"] = refundStatus;
  if (view === "refunds") filter["refund.status"] = refundStatus || { $ne: "not_applicable" };
  if (from || to) filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ returnNumber: rx }, { orderNumber: rx }, { "contact.name": rx }, { "contact.email": rx }, { "contact.phone": rx }, { "items.name": rx }, { "items.sku": rx }];
  }
  return filter;
}

const SORTS = { newest: { createdAt: -1 }, oldest: { createdAt: 1 }, updated: { updatedAt: -1 } };

export async function listReturns(query, { skip, limit }) {
  const filter = await returnFilter(query);
  const [items, total] = await Promise.all([
    ReturnRequest.find(filter).sort(SORTS[query.sort] || SORTS.newest).skip(skip).limit(limit).select("-history").lean(),
    ReturnRequest.countDocuments(filter),
  ]);
  return { items: items.map(adminListView), total };
}

export function adminListView(r) {
  return {
    id: String(r._id), returnNumber: r.returnNumber, orderId: String(r.order), orderNumber: r.orderNumber,
    customer: r.contact, items: r.items.map(({ name, sku, image, color, size, qty, price, condition, restockedQty }) => ({ name, sku, image, color, size, qty, price, condition, restockedQty })),
    quantity: r.items.reduce((s, i) => s + i.qty, 0), reason: r.reason, reasonLabel: r.reasonLabel || r.reason.replace(/_/g, " "), comments: r.comments,
    status: r.status, refund: { status: r.refund?.status || "not_applicable", amount: r.refund?.amount ?? null, refundId: r.refund?.refundId || null },
    evidenceCount: (r.evidence || []).length,
    createdAt: r.createdAt, decidedAt: r.decidedAt || null, receivedAt: r.receivedAt || null, inspectedAt: r.inspectedAt || null, completedAt: r.completedAt || null,
  };
}

export async function getReturnDetail(id) {
  const rr = await ReturnRequest.findById(id)
    .populate("decidedBy", "name email").populate("inspectedBy", "name email").populate("refund.by", "name email").populate("history.by", "name")
    .populate("refund.payment", "providerPaymentId providerOrderId provider method status")
    .lean();
  if (!rr) throw AppError.notFound("Return request not found.");
  const order = await Order.findById(rr.order).select("orderNumber status total subtotal couponDiscount prepaidDiscount shippingFee refundedAmount paymentMethod paymentStatus placedAt createdAt fulfilment").lean();
  const payment = order && await Payment.findOne({ order: order._id, status: { $in: ["captured", "partially_refunded", "refunded"] } }).sort({ createdAt: -1 }).select("providerPaymentId providerOrderId provider method").lean();
  const person = (u) => (u ? { id: String(u._id), name: u.name, email: u.email } : null);
  return {
    ...adminListView(rr),
    evidence: (rr.evidence || []).map((e) => ({ url: e.url, width: e.width, height: e.height })),
    adminNote: rr.adminNote, rejectionReason: rr.rejectionReason,
    decidedBy: person(rr.decidedBy), inspectedBy: person(rr.inspectedBy), inspectionNotes: rr.inspectionNotes,
    pickup: rr.pickup || null,
    refund: {
      status: rr.refund?.status || "not_applicable", amount: rr.refund?.amount ?? null, refundId: rr.refund?.refundId || null,
      initiatedAt: rr.refund?.initiatedAt || null, completedAt: rr.refund?.completedAt || null, failedAt: rr.refund?.failedAt || null,
      failureReason: rr.refund?.failureReason || "", by: person(rr.refund?.by),
      originalTransactionId: payment ? String(payment._id) : rr.refund?.payment ? String(rr.refund.payment._id) : null,
      originalPaymentId: payment?.providerPaymentId || rr.refund?.providerPaymentId || null,
      maxAmount: order ? maxRefundFor(rr.items, order) : 0,
    },
    order: order ? {
      id: String(order._id), orderNumber: order.orderNumber, status: order.status, total: order.total, refundedAmount: order.refundedAmount,
      paymentMethod: order.paymentMethod, paymentStatus: order.paymentStatus, placedAt: order.placedAt || order.createdAt, deliveredAt: order.fulfilment?.deliveredAt || null,
    } : null,
    allowedStatuses: STATUS_FLOW[rr.status],
    history: (rr.history || []).map((h) => ({ status: h.status || null, refundStatus: h.refundStatus || null, note: h.note || "", at: h.at, by: h.by?.name || null })),
  };
}

export async function returnSummary(query = {}) {
  const { from, to } = query;
  const match = from || to ? { createdAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {};
  const [byStatus, byRefund, returnedUnits] = await Promise.all([
    ReturnRequest.aggregate([{ $match: match }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    ReturnRequest.aggregate([{ $match: match }, { $group: { _id: "$refund.status", n: { $sum: 1 }, amount: { $sum: { $ifNull: ["$refund.amount", 0] } } } }]),
    ReturnRequest.aggregate([
      { $match: { ...match, status: { $in: ["received", "inspected", "completed"] } } }, { $unwind: "$items" },
      { $group: { _id: null, qty: { $sum: "$items.qty" }, restocked: { $sum: "$items.restockedQty" } } },
    ]),
  ]);
  const n = (statuses) => byStatus.filter((s) => statuses.includes(s._id)).reduce((t, s) => t + s.n, 0);
  const r = (statuses) => byRefund.filter((s) => statuses.includes(s._id));
  return {
    total: byStatus.reduce((t, s) => t + s.n, 0),
    pending: n(["requested"]),
    approved: n(["approved", "pickup_scheduled", "in_transit", "received", "inspected", "completed"]),
    rejected: n(["rejected"]),
    cancelled: n(["cancelled"]),
    inProgress: n(["approved", "pickup_scheduled", "in_transit", "received", "inspected"]),
    completed: n(["completed"]),
    productsReturned: returnedUnits[0]?.qty || 0,
    unitsRestocked: returnedUnits[0]?.restocked || 0,
    refundsPending: r(["pending", "processing", "failed"]).reduce((t, s) => t + s.n, 0),
    refundsFailed: r(["failed"]).reduce((t, s) => t + s.n, 0),
    refundsCompleted: r(["completed"]).reduce((t, s) => t + s.n, 0),
    refundedAmount: round2(r(["completed"]).reduce((t, s) => t + s.amount, 0)),
    byStatus: Object.fromEntries(byStatus.map((s) => [s._id, s.n])),
  };
}

/* Returned-product tracking: one row per returned item. */
export async function listReturnedItems(query, { skip, limit }) {
  const filter = await returnFilter(query);
  if (!query.status) filter.status = { $in: ["approved", "pickup_scheduled", "in_transit", "received", "inspected", "completed"] };
  const [result] = await ReturnRequest.aggregate([
    { $match: filter }, { $unwind: { path: "$items", includeArrayIndex: "index" } },
    ...(query.q ? [{ $match: { $or: [{ "items.name": new RegExp(escapeRegex(query.q), "i") }, { "items.sku": new RegExp(escapeRegex(query.q), "i") }, { returnNumber: new RegExp(escapeRegex(query.q), "i") }, { orderNumber: new RegExp(escapeRegex(query.q), "i") }, { "contact.name": new RegExp(escapeRegex(query.q), "i") }] } }] : []),
    { $facet: {
      total: [{ $count: "n" }],
      items: [{ $sort: { createdAt: -1, index: 1 } }, { $skip: skip }, { $limit: limit }],
    } },
  ]);
  return {
    total: result.total[0]?.n || 0,
    items: result.items.map((r) => ({
      returnId: String(r._id), returnNumber: r.returnNumber, orderId: String(r.order), orderNumber: r.orderNumber, customer: r.contact?.name,
      product: r.items.product ? String(r.items.product) : null, name: r.items.name, sku: r.items.sku, image: r.items.image,
      variant: [r.items.color, r.items.size].filter(Boolean).join(" / "), qty: r.items.qty,
      condition: r.items.condition, restockedQty: r.items.restockedQty || 0,
      requestedAt: r.createdAt, approvedAt: r.decidedAt || null, receivedAt: r.receivedAt || null, inspectedAt: r.inspectedAt || null,
      inspectionNotes: r.inspectionNotes || "", status: r.status,
    })),
  };
}

export const isObjectId = (v) => ObjectId.isValid(v) && /^[a-f\d]{24}$/i.test(v);
