import mongoose from "mongoose";
import { env } from "../config/env.js";
import { Cart, Coupon, InventoryMovement, Order, Payment, nextSequence } from "../models/commerce.js";
import { Product } from "../models/Product.js";
import { round2 } from "../models/shared.js";
import { audit } from "../models/AuditLog.js";
import { AppError } from "../utils/AppError.js";
import { logger } from "../utils/logger.js";
import { getSection } from "./settingsService.js";
import { getCart, priceCart } from "./cartService.js";
import { getRazorpay, toPaise } from "./razorpayService.js";
import { orderConfirmationEmail, orderStatusEmail, trySendMail } from "./emailService.js";

/* ---------- Status rules ---------- */
export const TRANSITIONS = {
  pending_payment: ["cancelled"],
  placed: ["confirmed", "packed", "shipped", "cancelled"],
  confirmed: ["packed", "shipped", "cancelled"],
  packed: ["shipped", "cancelled"],
  shipped: ["delivered", "returned"],
  delivered: ["returned"],
  cancelled: [],
  returned: [],
};
const CUSTOMER_CANCELLABLE = ["placed", "confirmed"];
const STOCK_HELD = ["pending_payment", "placed", "confirmed", "packed"]; // cancelling these returns stock

const ownerKey = ({ userId, guestId }) => (userId ? `u:${userId}` : `g:${guestId}`);

/* ---------- Stock (always inside a transaction) ---------- */
async function takeStock(items, orderId, session) {
  for (const it of items) {
    const res = await Product.updateOne(
      { _id: it.product, status: "active", variants: { $elemMatch: { _id: it.variant, status: "active", stock: { $gte: it.qty } } } },
      { $inc: { "variants.$.stock": -it.qty, totalStock: -it.qty, soldCount: it.qty } },
      { session },
    );
    if (!res.modifiedCount) {
      throw new AppError(409, "OUT_OF_STOCK", `Sorry, ${it.name}${it.size ? ` (${it.size})` : ""} just sold out or has fewer items left. Please review your bag.`, [{ path: String(it.variant), message: "insufficient_stock" }]);
    }
  }
  await InventoryMovement.insertMany(items.map((it) => ({ product: it.product, variant: it.variant, sku: it.sku, delta: -it.qty, reason: "order", order: orderId })), { session });
}

async function returnStock(order, reason, session) {
  for (const it of order.items) {
    // The product may have been archived or the variant removed since; restock what still exists.
    await Product.updateOne(
      { _id: it.product, "variants._id": it.variant },
      { $inc: { "variants.$[v].stock": it.qty, totalStock: it.qty, soldCount: -it.qty } },
      { session, arrayFilters: [{ "v._id": it.variant }] },
    );
  }
  await InventoryMovement.insertMany(order.items.map((it) => ({ product: it.product, variant: it.variant, sku: it.sku, delta: it.qty, reason, order: order._id })), { session });
}

async function releaseCoupon(order, session) {
  if (order.couponCode && order.couponDiscount > 0) await Coupon.updateOne({ code: order.couponCode, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } }, { session });
}

async function inTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); });
    return result;
  } finally {
    await session.endSession();
  }
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
  const totals = priced.totals[input.paymentMethod];
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
    trySendMail({ to: order.contact.email, ...orderConfirmationEmail(order) });
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
export async function markPaid(order, { providerPaymentId, method, amountPaise, via }) {
  if (amountPaise !== toPaise(order.total)) {
    await audit("payment.amount_mismatch", { entity: "Order", entityId: order._id, meta: { expected: toPaise(order.total), got: amountPaise, providerPaymentId } });
    throw new AppError(400, "AMOUNT_MISMATCH", "Payment amount does not match the order.");
  }
  await Payment.findOneAndUpdate({ order: order._id, provider: "razorpay" }, { $set: { providerPaymentId, status: "captured", method } }, { sort: { createdAt: -1 } });
  if (order.paymentStatus === "paid") return order;

  const now = new Date();
  if (order.stockReserved) {
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, paymentStatus: { $ne: "paid" } },
      { $set: { paymentStatus: "paid", status: order.status === "pending_payment" ? "placed" : order.status, placedAt: order.placedAt || now, reservationExpiresAt: null },
        $push: { history: { status: "placed", note: `Payment received (${via})`, at: now } } },
      { new: true },
    );
    if (updated && updated.contact.email) trySendMail({ to: updated.contact.email, ...orderConfirmationEmail(updated) });
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

export async function recordPaymentFailure(providerOrderId, { providerPaymentId, code, description }) {
  await Payment.updateOne({ providerOrderId, status: { $in: ["created", "failed"] } }, { $set: { status: "failed", providerPaymentId: providerPaymentId || undefined, errorCode: code, errorDescription: description } });
}

/* ---------- Cancellation ---------- */
export async function cancelOrder(orderId, { reason, by, byCustomer = false, system = false }) {
  return inTransaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    if (!order) throw AppError.notFound("Order not found.");
    const allowed = byCustomer ? CUSTOMER_CANCELLABLE : TRANSITIONS[order.status];
    if (!allowed.includes(byCustomer ? order.status : "cancelled")) {
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
    if (!system && order.contact.email) trySendMail({ to: order.contact.email, ...orderStatusEmail(order, "cancelled") });
    return order;
  });
}

/* ---------- Admin status changes ---------- */
export async function updateStatus(orderId, { status, note, fulfilment, restock = true }, actor) {
  if (status === "cancelled") return cancelOrder(orderId, { reason: note || "Cancelled by store", by: actor._id });
  const order = await Order.findById(orderId);
  if (!order) throw AppError.notFound("Order not found.");
  if (!TRANSITIONS[order.status].includes(status)) throw new AppError(409, "INVALID_TRANSITION", `Can't change a ${order.status.replace("_", " ")} order to ${status}.`);

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
      await inTransaction((session) => returnStock(order, "return", session));
      order.stockReserved = false;
    }
    if (order.paymentStatus === "paid") order.refundRequired = true;
  }
  order.status = status;
  order.history.push({ status, note, by: actor._id, at: now });
  await order.save();
  await audit("order.status_changed", { actor: actor._id, entity: "Order", entityId: order._id, meta: { orderNumber: order.orderNumber, status } });
  if (order.contact.email) {
    const mail = orderStatusEmail(order, status);
    if (mail) trySendMail({ to: order.contact.email, ...mail });
  }
  return order;
}

/* ---------- Refunds (admins only) ---------- */
export async function refundOrder(orderId, { amount, reason, manualReference }, actor) {
  const order = await Order.findById(orderId);
  if (!order) throw AppError.notFound("Order not found.");
  if (!["paid", "partially_refunded"].includes(order.paymentStatus)) throw new AppError(409, "NOT_REFUNDABLE", "Only paid orders can be refunded.");
  const refundable = round2(order.total - order.refundedAmount);
  const value = round2(amount ?? refundable);
  if (value <= 0 || value > refundable) throw AppError.badRequest(`Refund must be between ₹0.01 and ₹${refundable}.`);

  const payment = await Payment.findOne({ order: order._id, status: { $in: ["captured", "partially_refunded"] } }).sort({ createdAt: -1 });
  let refundId, refundStatus;
  if (order.paymentMethod === "razorpay") {
    if (!payment?.providerPaymentId) throw new AppError(409, "NOT_REFUNDABLE", "No captured online payment found for this order.");
    try {
      const r = await getRazorpay().refund(payment.providerPaymentId, { amount: toPaise(value), notes: { orderNumber: order.orderNumber, reason: reason || "" } });
      refundId = r.id;
      refundStatus = r.status;
    } catch (err) {
      logger.error({ err: err?.message ?? err?.error?.description, orderNumber: order.orderNumber }, "Razorpay refund failed");
      throw new AppError(502, "REFUND_FAILED", `Razorpay rejected the refund: ${err?.error?.description || "please try again"}.`);
    }
  } else {
    if (!manualReference) throw AppError.badRequest("Cash on delivery refunds are paid outside the system; enter the bank/UPI reference.");
    refundId = manualReference;
    refundStatus = "processed";
  }

  const refundedAmount = round2(order.refundedAmount + value);
  const full = refundedAmount >= order.total;
  order.refundedAmount = refundedAmount;
  order.paymentStatus = full ? "refunded" : "partially_refunded";
  order.refundRequired = !full && order.refundRequired;
  order.needsAttention = full ? null : order.needsAttention;
  order.history.push({ status: order.status, note: `Refund ₹${value} (${refundId})${reason ? `: ${reason}` : ""}`, by: actor._id, at: new Date() });
  await order.save();
  if (payment) {
    payment.refunds.push({ refundId, amount: value, status: refundStatus, by: actor._id });
    payment.refundedAmount = round2(payment.refundedAmount + value);
    payment.status = full ? "refunded" : "partially_refunded";
    await payment.save();
  }
  await audit("order.refunded", { actor: actor._id, entity: "Order", entityId: order._id, meta: { orderNumber: order.orderNumber, amount: value, refundId } });
  return order;
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
        if (captured) { await markPaid(order, { providerPaymentId: captured.id, method: captured.method, amountPaise: captured.amount, via: "reconciliation" }); continue; }
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
