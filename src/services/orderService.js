import mongoose from "mongoose";
import { env } from "../config/env.js";
import { Cart, Coupon, InventoryMovement, Order, Payment, ReturnRequest, nextSequence } from "../models/commerce.js";
import { Product } from "../models/Product.js";
import { round2 } from "../models/shared.js";
import { audit } from "../models/AuditLog.js";
import { AppError } from "../utils/AppError.js";
import { logger } from "../utils/logger.js";
import { inTransaction } from "../utils/transaction.js";
import { getSection } from "./settingsService.js";
import { getCart, priceCart } from "./cartService.js";
import { getRazorpay, paymentMethodDetails, toPaise } from "./razorpayService.js";
import { orderConfirmationEmail, orderStatusEmail, trySendMail } from "./emailService.js";
import { notifyReturnRefunded } from "./notifyService.js";

/* Order-update emails respect the switches in Notifications → Email Notifications. Fire-and-forget. */
const ORDER_EMAIL_SWITCH = { confirmation: "orderConfirmation", shipped: "orderShipped", delivered: "orderDelivered", cancelled: "orderCancelled" };
function sendOrderEmail(order, kind) {
  if (!order?.contact?.email) return;
  const message = kind === "confirmation" ? orderConfirmationEmail(order) : orderStatusEmail(order, kind);
  if (!message) return;
  getSection("notifications").then((n) => {
    if (n[ORDER_EMAIL_SWITCH[kind]] === false) return;
    return trySendMail({ to: order.contact.email, ...message, type: kind === "confirmation" ? "order_confirmation" : "order_status", ref: order.orderNumber });
  }).catch(() => {});
}

/* ---------- Status rules ---------- */
export const TRANSITIONS = {
  pending_payment: ["cancelled"],
  placed: ["confirmed", "packed", "shipped", "cancelled"],
  confirmed: ["packed", "shipped", "cancelled"],
  packed: ["shipped", "cancelled"],
  shipped: ["delivered", "returned"],
  // Admins may correct a mistakenly marked delivered order from the status dropdown.
  delivered: ["confirmed", "packed", "shipped", "cancelled", "returned"],
  cancelled: [],
  returned: [],
};
const CUSTOMER_CANCELLABLE = ["placed", "confirmed"];
const STOCK_HELD = ["pending_payment", "placed", "confirmed", "packed"]; // cancelling these returns stock

const ownerKey = ({ userId, guestId }) => (userId ? `u:${userId}` : `g:${guestId}`);

/* ---------- Stock (always inside a transaction) ---------- */
async function takeStock(items, orderId, session) {
  const moves = [];
  for (const it of items) {
    const updated = await Product.findOneAndUpdate(
      { _id: it.product, status: "active", variants: { $elemMatch: { _id: it.variant, status: "active", stock: { $gte: it.qty } } } },
      { $inc: { "variants.$.stock": -it.qty, totalStock: -it.qty, soldCount: it.qty } },
      { session, new: true, projection: { variants: { $elemMatch: { _id: it.variant } } } },
    ).lean();
    if (!updated) {
      throw new AppError(409, "OUT_OF_STOCK", `Sorry, ${it.name}${it.size ? ` (${it.size})` : ""} just sold out or has fewer items left. Please review your bag.`, [{ path: String(it.variant), message: "insufficient_stock" }]);
    }
    const after = updated.variants[0].stock;
    moves.push({ product: it.product, variant: it.variant, sku: it.sku, delta: -it.qty, before: after + it.qty, after, reason: "order", order: orderId });
  }
  await InventoryMovement.insertMany(moves, { session });
}

/* Puts `qty` units back on a variant (inside a transaction). Returns the movement fields, or null if the
   product/variant no longer exists. totalStock only counts active variants, so it follows the variant status. */
export async function restockVariant({ product, variant, qty }, session) {
  const current = await Product.findOne({ _id: product, "variants._id": variant }, { "variants.$": 1 }).session(session).lean();
  if (!current || qty <= 0) return null;
  const v = current.variants[0];
  await Product.updateOne(
    { _id: product, "variants._id": variant },
    { $inc: { "variants.$.stock": qty, soldCount: -qty, ...(v.status === "active" ? { totalStock: qty } : {}) } },
    { session },
  );
  return { before: v.stock, after: v.stock + qty };
}

/* `alreadyRestocked` (variant id → qty) skips units a return inspection has already put back. */
async function returnStock(order, reason, session, alreadyRestocked = new Map()) {
  const moves = [];
  for (const it of order.items) {
    const qty = it.qty - (alreadyRestocked.get(String(it.variant)) || 0);
    // The product may have been archived or the variant removed since; restock what still exists.
    const res = await restockVariant({ product: it.product, variant: it.variant, qty }, session);
    if (res) moves.push({ product: it.product, variant: it.variant, sku: it.sku, delta: qty, ...res, reason, order: order._id });
  }
  if (moves.length) await InventoryMovement.insertMany(moves, { session });
}

async function releaseCoupon(order, session) {
  if (order.couponCode && order.couponDiscount > 0) await Coupon.updateOne({ code: order.couponCode, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } }, { session });
}


/* ---------- Checkout ---------- */
export async function createOrder({ owner, input, ip }) {
  const key = input.idempotencyKey ? `${ownerKey(owner)}:${input.idempotencyKey}` : null;
  if (key) {
    const existing = await Order.findOne({ idempotencyKey: key });
    if (existing) return { order: existing, payment: await paymentPayload(existing), replayed: true };
  }

  const cart = await getCart(owner);
  if (!cart.items?.length) throw new AppError(400, "CART_EMPTY", "Your bag is empty.");
  const priced = await priceCart(cart, { userId: owner.userId, phone: input.contact.phone });
  if (priced.hasIssues) throw new AppError(409, "CART_ISSUES", "Some items in your bag are unavailable. Please review your bag.", priced.lines.filter((l) => !l.available).map((l) => ({ path: l.itemId, message: l.message })));
  if (priced.coupon && !priced.coupon.applied && !/more to use/.test(priced.coupon.message)) throw new AppError(409, "COUPON_INVALID", priced.coupon.message);

  const commerce = await getSection("commerce");
  const configuredShipping = await getSection("shipping");
  const pin = String(input.shippingAddress?.pincode || "");
  let shippingFee = priced.totals[input.paymentMethod].shippingFee;
  if (configuredShipping.pincodes.length) {
    const rate = configuredShipping.pincodes.find((entry) => entry.code === pin && entry.enabled);
    const state = rate && configuredShipping.states.find((entry) => entry.enabled && entry.name.toLowerCase() === rate.state.toLowerCase());
    const district = state?.districts.find((entry) => entry.enabled && entry.name.toLowerCase() === rate.district.toLowerCase());
    if (!rate || !district) throw new AppError(400, "DELIVERY_UNAVAILABLE", "Delivery is not available for this PIN code.");
    shippingFee = rate.price;
  }
  const baseTotals = priced.totals[input.paymentMethod];
  const totals = { ...baseTotals, shippingFee, total: Math.max(0, baseTotals.total - baseTotals.shippingFee + shippingFee) };
  if (input.paymentMethod === "cod") {
    if (!commerce.codEnabled) throw new AppError(400, "COD_UNAVAILABLE", "Cash on delivery is not available right now.");
    if (commerce.codMaxOrderValue && totals.total > commerce.codMaxOrderValue) throw new AppError(400, "COD_UNAVAILABLE", `Cash on delivery is available for orders up to ₹${commerce.codMaxOrderValue.toLocaleString("en-IN")}.`);
  } else {
    getRazorpay(); // fails fast with PAYMENTS_NOT_CONFIGURED before any stock is touched
  }

  const items = priced.lines.map((l) => ({
    product: l.productId, variant: l.variantId, sku: l.sku, name: l.name, slug: l.slug, image: l.image,
    color: l.color, size: l.size, price: l.price, mrp: l.mrp, qty: l.qty, lineTotal: l.lineTotal,
  }));
  const isCod = input.paymentMethod === "cod";
  const couponApplied = priced.coupon?.applied ? priced.coupon.code : null;

  let order;
  try {
    order = await inTransaction(async (session) => {
      const orderId = new mongoose.Types.ObjectId();
      await takeStock(items, orderId, session);
      if (couponApplied) {
        const c = await Coupon.updateOne(
          { code: couponApplied, status: "active", $or: [{ usageLimit: null }, { $expr: { $lt: ["$usedCount", "$usageLimit"] } }] },
          { $inc: { usedCount: 1 } }, { session },
        );
        if (!c.modifiedCount) throw new AppError(409, "COUPON_INVALID", `“${couponApplied}” is no longer available.`);
      }
      const seq = await nextSequence("order", session);
      const now = new Date();
      const [created] = await Order.create([{
        _id: orderId, orderNumber: `SZ${100000 + seq}`, user: owner.userId || undefined, guestId: owner.userId ? undefined : owner.guestId,
        contact: input.contact, items, shippingAddress: input.shippingAddress,
        subtotal: totals.subtotal, mrpTotal: totals.mrpTotal, couponCode: couponApplied || undefined, couponDiscount: totals.couponDiscount,
        prepaidDiscount: totals.prepaidDiscount, shippingFee: totals.shippingFee, total: totals.total,
        paymentMethod: input.paymentMethod, paymentStatus: "pending",
        status: isCod ? "placed" : "pending_payment", stockReserved: true,
        reservationExpiresAt: isCod ? undefined : new Date(now.getTime() + env.ORDER_RESERVATION_MINUTES * 60_000),
        placedAt: isCod ? now : undefined, notes: input.notes, idempotencyKey: key || undefined,
        history: [{ status: isCod ? "placed" : "pending_payment", note: isCod ? "Order placed (Cash on delivery)" : "Awaiting online payment", at: now }],
      }], { session });
      if (isCod) await Payment.create([{ order: orderId, provider: "cod", amount: totals.total, status: "pending" }], { session });
      await Cart.updateOne({ _id: cart._id }, { $set: { items: [], couponCode: null } }, { session });
      return created;
    });
  } catch (err) {
    // Same idempotency key raced in from a double-click: return the order that won.
    if (err?.code === 11000 && key) {
      const existing = await Order.findOne({ idempotencyKey: key });
      if (existing) return { order: existing, payment: await paymentPayload(existing), replayed: true };
    }
    throw err;
  }

  if (!isCod) {
    try {
      const rzp = await getRazorpay().createOrder({ amount: toPaise(order.total), currency: "INR", receipt: order.orderNumber, notes: { orderNumber: order.orderNumber } });
      await Payment.create({ order: order._id, provider: "razorpay", providerOrderId: rzp.id, amount: order.total, status: "created" });
    } catch (err) {
      // Gateway unreachable: undo the reservation and give the shopper their bag back.
      logger.error({ err: err?.message, orderNumber: order.orderNumber }, "Razorpay order creation failed");
      await cancelOrder(order._id, { reason: "Payment gateway unavailable", system: true });
      await Cart.updateOne({ _id: cart._id }, { $set: { items: cart.items.map((i) => ({ product: i.product, variant: i.variant, qty: i.qty })), couponCode: cart.couponCode } });
      throw new AppError(502, "PAYMENT_GATEWAY_ERROR", "We couldn't start the online payment. Your bag has been kept — please try again or choose Cash on delivery.");
    }
  } else if (order.contact.email) {
    sendOrderEmail(order, "confirmation");
  }
  await audit("order.created", { actor: owner.userId, entity: "Order", entityId: order._id, ip, meta: { orderNumber: order.orderNumber, total: order.total, paymentMethod: order.paymentMethod } });
  return { order, payment: await paymentPayload(order) };
}

/* What the storefront needs to open Razorpay Checkout for a pending order. */
export async function paymentPayload(order) {
  if (order.paymentMethod !== "razorpay" || order.paymentStatus === "paid" || order.status !== "pending_payment") return null;
  const p = await Payment.findOne({ order: order._id, provider: "razorpay" }).sort({ createdAt: -1 });
  if (!p) return null;
  return {
    provider: "razorpay", keyId: getRazorpay().keyId, razorpayOrderId: p.providerOrderId, amount: toPaise(order.total), currency: "INR",
    name: "Shoponzy", description: `Order ${order.orderNumber}`, prefill: { name: order.contact.name, email: order.contact.email || "", contact: order.contact.phone },
    expiresAt: order.reservationExpiresAt,
  };
}

/* ---------- Payment confirmation (from the checkout callback or a webhook; idempotent) ---------- */
export async function markPaid(order, { providerPaymentId, method, details, amountPaise, via }) {
  if (amountPaise !== toPaise(order.total)) {
    await audit("payment.amount_mismatch", { entity: "Order", entityId: order._id, meta: { expected: toPaise(order.total), got: amountPaise, providerPaymentId } });
    throw new AppError(400, "AMOUNT_MISMATCH", "Payment amount does not match the order.");
  }
  const record = await Payment.findOne({ order: order._id, provider: "razorpay" }).sort({ createdAt: -1 });
  if (record) {
    record.providerPaymentId = providerPaymentId;
    record.method = method;
    if (details) record.methodDetails = details;
    record.capturedAt ||= new Date();
    // A late webhook for an already-refunded payment must not turn it back into "captured".
    if (!["refunded", "partially_refunded"].includes(record.status)) record.status = "captured";
    record.errorCode = record.errorDescription = record.errorSource = record.errorStep = record.errorReason = undefined;
    await record.save();
  }
  if (["paid", "refunded", "partially_refunded"].includes(order.paymentStatus)) return order;

  const now = new Date();
  if (order.stockReserved) {
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, paymentStatus: { $ne: "paid" } },
      { $set: { paymentStatus: "paid", status: order.status === "pending_payment" ? "placed" : order.status, placedAt: order.placedAt || now, reservationExpiresAt: null },
        $push: { history: { status: "placed", note: `Payment received (${via})`, at: now } } },
      { new: true },
    );
    if (updated) sendOrderEmail(updated, "confirmation");
    return updated || Order.findById(order._id);
  }

  // Paid after the reservation expired: try to take the stock again.
  try {
    return await inTransaction(async (session) => {
      await takeStock(order.items, order._id, session);
      await InventoryMovement.updateMany({ order: order._id, reason: "order", createdAt: { $gte: now } }, { $set: { reason: "late_payment" } }, { session });
      const o = await Order.findByIdAndUpdate(order._id, {
        $set: { paymentStatus: "paid", status: "placed", stockReserved: true, placedAt: now, cancelReason: null, reservationExpiresAt: null },
        $push: { history: { status: "placed", note: `Payment received after the reservation expired; stock re-reserved (${via})`, at: now } },
      }, { new: true, session });
      return o;
    });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    const o = await Order.findByIdAndUpdate(order._id, {
      $set: { paymentStatus: "paid", refundRequired: true, needsAttention: "Paid after reservation expired, but items are out of stock. Refund or fulfil manually." },
      $push: { history: { status: order.status, note: `Payment received after expiry; stock unavailable — refund required (${via})`, at: now } },
    }, { new: true });
    await audit("order.paid_out_of_stock", { entity: "Order", entityId: order._id, meta: { orderNumber: order.orderNumber } });
    return o;
  }
}

/* A failed attempt on a payment that hasn't been captured. Razorpay lets the shopper retry on the same
   order, so a later success (markPaid) overwrites this. */
export async function recordPaymentFailure(providerOrderId, { providerPaymentId, code, description, source, step, reason, method, details }) {
  await Payment.updateOne({ providerOrderId, status: { $in: ["created", "failed"] } }, { $set: {
    status: "failed", providerPaymentId: providerPaymentId || undefined, errorCode: code, errorDescription: description,
    errorSource: source, errorStep: step, errorReason: reason, method, ...(details ? { methodDetails: details } : {}),
  } });
}

/* ---------- Cancellation ---------- */
export async function cancelOrder(orderId, { reason, by, byCustomer = false, system = false, force = false }) {
  return inTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw AppError.notFound("Order not found.");
    const allowed = byCustomer ? CUSTOMER_CANCELLABLE : TRANSITIONS[order.status];
    if (!force && !allowed.includes(byCustomer ? order.status : "cancelled")) {
      throw new AppError(409, "INVALID_TRANSITION", byCustomer ? "This order can no longer be cancelled online. Please contact us." : `A ${order.status.replace("_", " ")} order can't be cancelled.`);
    }
    if (order.stockReserved && STOCK_HELD.includes(order.status)) {
      await returnStock(order, system && order.status === "pending_payment" ? "reservation_expired" : "order_cancelled", session);
      order.stockReserved = false;
    }
    await releaseCoupon(order, session);
    if (order.paymentStatus === "paid") order.refundRequired = true;
    if (order.paymentMethod === "cod") await Payment.updateOne({ order: order._id, provider: "cod" }, { $set: { status: "failed", errorDescription: "Order cancelled" } }, { session });
    order.status = "cancelled";
    order.cancelReason = reason;
    order.reservationExpiresAt = null;
    order.history.push({ status: "cancelled", note: reason, by, at: new Date() });
    await order.save({ session });
    return order;
  }).then((order) => {
    if (!system) sendOrderEmail(order, "cancelled");
    return order;
  });
}

/* ---------- Admin status changes ---------- */
export async function updateStatus(orderId, { status, note, fulfilment, restock = true, force = false }, actor) {
  if (status === "cancelled") return cancelOrder(orderId, { reason: note || "Cancelled by store", by: actor._id, force });
  const order = await Order.findById(orderId);
  if (!order) throw AppError.notFound("Order not found.");
  if (!force && !TRANSITIONS[order.status].includes(status)) throw new AppError(409, "INVALID_TRANSITION", `Can't change a ${order.status.replace("_", " ")} order to ${status}.`);

  if (force && order.status === "cancelled" && !order.stockReserved) {
    const now = new Date();
    const reopened = await inTransaction(async (session) => {
      const current = await Order.findById(orderId).session(session);
      if (!current) throw AppError.notFound("Order not found.");
      if (current.status !== "cancelled" || current.stockReserved) throw new AppError(409, "ORDER_CHANGED", "The order changed while its status was being updated. Refresh and try again.");
      await takeStock(current.items, current._id, session);
      current.stockReserved = true;
      current.cancelReason = null;
      current.reservationExpiresAt = null;
      if (status === "shipped") current.fulfilment = { ...current.fulfilment?.toObject?.(), shippedAt: now };
      if (status === "delivered") {
        current.fulfilment = { ...current.fulfilment?.toObject?.(), deliveredAt: now };
        if (current.paymentMethod === "cod") {
          current.paymentStatus = "paid";
          await Payment.updateOne({ order: current._id, provider: "cod" }, { $set: { status: "captured" } }, { session });
        }
      }
      current.status = status;
      current.history.push({ status, note, by: actor._id, at: now });
      await current.save({ session });
      return current;
    });
    await audit("order.status_changed", { actor: actor._id, entity: "Order", entityId: reopened._id, meta: { orderNumber: reopened.orderNumber, status } });
    sendOrderEmail(reopened, status);
    return reopened;
  }

  const now = new Date();
  if (fulfilment) order.fulfilment = { ...order.fulfilment?.toObject?.(), ...fulfilment };
  if (status === "shipped") order.fulfilment = { ...order.fulfilment?.toObject?.(), shippedAt: now };
  if (status === "delivered") {
    order.fulfilment = { ...order.fulfilment?.toObject?.(), deliveredAt: now };
    if (order.paymentMethod === "cod") {
      order.paymentStatus = "paid";
      await Payment.updateOne({ order: order._id, provider: "cod" }, { $set: { status: "captured" } });
    }
  }
  if (status === "returned") {
    if (restock) {
      // Units a return inspection already put back are not added twice.
      const restocked = await ReturnRequest.aggregate([
        { $match: { order: order._id } }, { $unwind: "$items" },
        { $group: { _id: "$items.variant", qty: { $sum: "$items.restockedQty" } } },
      ]);
      await inTransaction((session) => returnStock(order, "return", session, new Map(restocked.map((r) => [String(r._id), r.qty]))));
      order.stockReserved = false;
    }
    if (order.paymentStatus === "paid") order.refundRequired = true;
  }
  order.status = status;
  order.history.push({ status, note, by: actor._id, at: now });
  await order.save();
  await audit("order.status_changed", { actor: actor._id, entity: "Order", entityId: order._id, meta: { orderNumber: order.orderNumber, status } });
  sendOrderEmail(order, status);
  return order;
}

/* ---------- Refunds (admins only) ---------- */
const REFUND_LOCK_MS = 2 * 60_000;

/* Issues a refund through Razorpay (or records a manual COD refund). One refund per order at a time:
   the order is locked while the gateway call is in flight, so a double click or two admins can't both
   refund the same balance. Amounts are always checked against what the database says is refundable. */
export async function issueRefund(orderId, { amount, reason, manualReference, returnRequest }, actor) {
  const now = new Date();
  const order = await Order.findOneAndUpdate(
    { _id: orderId, $or: [{ refundLockedAt: null }, { refundLockedAt: { $lt: new Date(now.getTime() - REFUND_LOCK_MS) } }] },
    { $set: { refundLockedAt: now } }, { new: true },
  );
  if (!order) {
    if (await Order.exists({ _id: orderId })) throw new AppError(409, "REFUND_IN_PROGRESS", "A refund for this order is already being processed. Refresh in a moment.");
    throw AppError.notFound("Order not found.");
  }
  try {
    if (!["paid", "partially_refunded"].includes(order.paymentStatus)) throw new AppError(409, "NOT_REFUNDABLE", "Only paid orders can be refunded.");
    const refundable = round2(order.total - order.refundedAmount);
    const value = round2(amount ?? refundable);
    if (value <= 0 || value > refundable) throw AppError.badRequest(`Refund must be between ₹0.01 and ₹${refundable}.`);

    const payment = await Payment.findOne({ order: order._id, status: { $in: ["captured", "partially_refunded"] } }).sort({ createdAt: -1 });
    let refundId, refundStatus;
    if (order.paymentMethod === "razorpay") {
      if (!payment?.providerPaymentId) throw new AppError(409, "NOT_REFUNDABLE", "No captured online payment found for this order.");
      const gateway = getRazorpay(); // PAYMENTS_NOT_CONFIGURED surfaces as itself, not as a rejected refund
      try {
        const r = await gateway.refund(payment.providerPaymentId, {
          amount: toPaise(value),
          notes: { orderNumber: order.orderNumber, reason: reason || "", ...(returnRequest ? { returnRequest: String(returnRequest) } : {}) },
        });
        refundId = r.id;
        refundStatus = r.status || "pending";
      } catch (err) {
        logger.error({ err: err?.message ?? err?.error?.description, orderNumber: order.orderNumber }, "Razorpay refund failed");
        throw new AppError(502, "REFUND_FAILED", `Razorpay rejected the refund: ${err?.error?.description || "please try again"}.`);
      }
    } else {
      if (!manualReference) throw AppError.badRequest("Cash on delivery refunds are paid outside the system; enter the bank/UPI reference.");
      if (payment?.refunds.some((r) => r.refundId === manualReference)) throw AppError.conflict("This refund reference has already been recorded.");
      refundId = manualReference;
      refundStatus = "processed";
    }

    const refundedAmount = round2(order.refundedAmount + value);
    const full = refundedAmount >= order.total;
    order.refundedAmount = refundedAmount;
    order.paymentStatus = full ? "refunded" : "partially_refunded";
    order.refundRequired = !full && order.refundRequired;
    order.needsAttention = full ? null : order.needsAttention;
    order.refundLockedAt = null;
    order.history.push({ status: order.status, note: `Refund ₹${value} (${refundId}, ${refundStatus})${reason ? `: ${reason}` : ""}`, by: actor._id, at: new Date() });
    await order.save();
    if (payment) {
      payment.refunds.push({
        refundId, amount: value, status: refundStatus, by: actor._id, reason, returnRequest,
        manual: order.paymentMethod !== "razorpay", processedAt: refundStatus === "processed" ? new Date() : undefined,
      });
      payment.refundedAmount = round2(payment.refundedAmount + value);
      payment.status = full ? "refunded" : "partially_refunded";
      await payment.save();
    }
    await audit("order.refunded", { actor: actor._id, entity: "Order", entityId: order._id, meta: { orderNumber: order.orderNumber, amount: value, refundId, status: refundStatus, returnRequest: returnRequest && String(returnRequest) } });
    return { order, refund: { refundId, amount: value, status: refundStatus, payment: payment?._id, providerPaymentId: payment?.providerPaymentId } };
  } finally {
    // Released on every path (the success path already cleared it on the saved order).
    await Order.updateOne({ _id: order._id, refundLockedAt: now }, { $set: { refundLockedAt: null } });
  }
}

export const refundOrder = async (orderId, input, actor) => (await issueRefund(orderId, input, actor)).order;

/* Applies a refund status that came from Razorpay (webhook or an explicit fetch). Idempotent.
   A failed refund gives the money back to the order's refundable balance and flags the order. */
export async function applyRefundStatus({ refundId, status, failureReason, via }) {
  if (!refundId || !status) return null;
  const payment = await Payment.findOne({ "refunds.refundId": refundId });
  if (!payment) return null;
  const entry = payment.refunds.find((r) => r.refundId === refundId);
  if (entry.status === status || entry.status === "failed") return { payment, entry, changed: false }; // unchanged or already final
  const now = new Date();
  entry.status = status;
  if (status === "processed") entry.processedAt ||= now;
  if (status === "failed") {
    entry.failedAt = now;
    entry.failureReason = failureReason || "Refund failed at the gateway";
    payment.refundedAmount = round2(Math.max(0, payment.refundedAmount - entry.amount));
    payment.status = payment.refundedAmount > 0 ? "partially_refunded" : "captured";
    const order = await Order.findById(payment.order);
    if (order) {
      order.refundedAmount = round2(Math.max(0, order.refundedAmount - entry.amount));
      order.paymentStatus = order.refundedAmount > 0 ? "partially_refunded" : "paid";
      order.refundRequired = true;
      order.needsAttention = `Refund ${refundId} of ₹${entry.amount} failed${failureReason ? `: ${failureReason}` : ""}. Retry the refund.`;
      order.history.push({ status: order.status, note: `Refund ${refundId} failed (${via})`, at: now });
      await order.save();
    }
  }
  await payment.save();
  // A refund made for a return request carries its status over.
  const returnStatus = { processed: "completed", failed: "failed", pending: "processing" }[status];
  if (returnStatus) {
    await ReturnRequest.updateOne({ "refund.refundId": refundId, "refund.status": { $ne: returnStatus } }, {
      $set: {
        "refund.status": returnStatus,
        ...(status === "processed" ? { "refund.completedAt": now } : {}),
        ...(status === "failed" ? { "refund.failedAt": now, "refund.failureReason": entry.failureReason } : {}),
      },
      $push: { history: { refundStatus: returnStatus, note: `Refund ${refundId} ${status} (${via})`, at: now } },
    });
  }
  await audit("refund.status_changed", { entity: "Payment", entityId: payment._id, meta: { refundId, status, via } });
  if (status === "processed") await notifyReturnRefunded(refundId).catch(() => {});
  return { payment, entry, changed: true };
}

/* Asks Razorpay for a refund's current status (for when a webhook was missed). */
export async function syncRefund(paymentId, refundId) {
  const payment = await Payment.findById(paymentId);
  const entry = payment?.refunds.find((r) => r.refundId === refundId);
  if (!entry) throw AppError.notFound("Refund not found.");
  if (entry.manual || payment.provider !== "razorpay") return { status: entry.status, changed: false };
  let r;
  try {
    r = await getRazorpay().fetchRefund(payment.providerPaymentId, refundId);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(502, "GATEWAY_ERROR", `Couldn't reach Razorpay: ${err?.error?.description || "please try again"}.`);
  }
  const result = await applyRefundStatus({ refundId, status: r.status, failureReason: r.error_description || r.notes?.failure_reason, via: "sync" });
  return { status: r.status, changed: Boolean(result?.changed) };
}

/* ---------- Reservation expiry (background job) ---------- */
export async function expireReservations(now = new Date()) {
  const due = await Order.find({ status: "pending_payment", stockReserved: true, reservationExpiresAt: { $lt: now } }).limit(100);
  let released = 0;
  for (const order of due) {
    try {
      // A payment may have succeeded while its webhook is still on the way: ask Razorpay before releasing.
      const p = await Payment.findOne({ order: order._id, provider: "razorpay" }).sort({ createdAt: -1 });
      if (p?.providerOrderId) {
        let payments = [];
        try {
          payments = await getRazorpay().fetchOrderPayments(p.providerOrderId);
        } catch (err) {
          // Keys removed since the order was made: nothing can be paid, so releasing is safe. Other errors retry later.
          if (err?.code !== "PAYMENTS_NOT_CONFIGURED") throw err;
        }
        const captured = payments.find((x) => x.status === "captured");
        if (captured) { await markPaid(order, { providerPaymentId: captured.id, method: captured.method, details: paymentMethodDetails(captured), amountPaise: captured.amount, via: "reconciliation" }); continue; }
      }
      await cancelOrder(order._id, { reason: "Payment not completed in time", system: true });
      released++;
    } catch (err) {
      logger.warn({ err: err?.message, orderNumber: order.orderNumber }, "Could not process expired reservation; will retry");
    }
  }
  return released;
}

/* ---------- Views ---------- */
export function customerOrderView(o) {
  const order = typeof o.toJSON === "function" ? o.toJSON() : o;
  const { user: _u, needsAttention: _n, guestId: _g, idempotencyKey: _i, ...rest } = order;
  return { ...rest, history: (order.history || []).map(({ status, note, at }) => ({ status, note, at })) };
}
