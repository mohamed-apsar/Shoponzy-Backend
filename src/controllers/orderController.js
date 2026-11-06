import { Order, Payment, WebhookEvent } from "../models/commerce.js";
import { User } from "../models/User.js";
import * as orders from "../services/orderService.js";
import { getRazorpay, paymentFailure, paymentMethodDetails, verifyCheckoutSignature, verifyWebhookSignature } from "../services/razorpayService.js";
import { AppError } from "../utils/AppError.js";
import { logger } from "../utils/logger.js";
import { created, ok, paginate } from "../utils/respond.js";

/* POST /orders — checkout. Saved addresses are resolved server-side; prices come from the database. */
export async function checkout(req, res) {
  const input = { ...req.valid.body };
  if (input.addressId) {
    if (!req.owner.userId) throw AppError.badRequest("Sign in to use a saved address.");
    const user = await User.findById(req.owner.userId);
    const a = user.addresses.id(input.addressId);
    if (!a) throw AppError.badRequest("Saved address not found.");
    input.shippingAddress = { name: a.name, phone: a.phone, line1: a.line1, line2: a.line2, city: a.city, state: a.state, pincode: a.pincode };
  } else if (input.saveAddress && req.owner.userId) {
    const user = await User.findById(req.owner.userId);
    if (user.addresses.length < 10) {
      user.addresses.push({ ...input.shippingAddress, isDefault: user.addresses.length === 0 });
      await user.save();
    }
  }
  const { order, payment, replayed } = await orders.createOrder({ owner: req.owner, input, ip: req.ip });
  (replayed ? ok : created)(res, { order: orders.customerOrderView(order), payment });
}

/* An order the current visitor may see: their own (signed in) or one placed from this browser (guest). */
async function findOwnOrder(req) {
  const orderNumber = String(req.params.orderNumber).toUpperCase();
  const scope = req.owner.userId ? { user: req.owner.userId } : req.owner.guestId ? { guestId: req.owner.guestId } : null;
  const order = scope && (await Order.findOne({ orderNumber, ...scope }));
  if (!order) throw AppError.notFound("Order not found.");
  return order;
}

export async function myOrders(req, res) {
  const { skip, limit, meta } = paginate(req.valid.query);
  const filter = { user: req.owner.userId, status: { $ne: "pending_payment" } };
  const [items, total] = await Promise.all([Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit), Order.countDocuments(filter)]);
  ok(res, items.map(orders.customerOrderView), meta(total));
}

export async function myOrder(req, res) {
  const order = await findOwnOrder(req);
  ok(res, { order: orders.customerOrderView(order), payment: await orders.paymentPayload(order) });
}

export async function cancelMyOrder(req, res) {
  const order = await findOwnOrder(req);
  const updated = await orders.cancelOrder(order._id, { reason: req.valid.body.reason || "Cancelled by customer", by: req.owner.userId, byCustomer: true });
  ok(res, orders.customerOrderView(updated));
}

/* Guests (and anyone) can check status with order ID + the phone number used at checkout. Limited view. */
export async function track(req, res) {
  const { orderNumber, phone } = req.valid.body;
  const order = await Order.findOne({ orderNumber, "contact.phone": phone, status: { $ne: "pending_payment" } }).lean();
  if (!order) throw AppError.notFound("We couldn't find an order with that ID and phone number.");
  ok(res, {
    orderNumber: order.orderNumber, status: order.status, paymentStatus: order.paymentStatus, paymentMethod: order.paymentMethod,
    total: order.total, placedAt: order.placedAt || order.createdAt, itemCount: order.items.reduce((s, i) => s + i.qty, 0),
    fulfilment: order.fulfilment, history: order.history.map(({ status, at }) => ({ status, at })),
  });
}

/* POST /payments/razorpay/verify — Checkout success callback. The signature proves Razorpay issued it;
   the payment is then fetched from Razorpay to confirm it was captured for the right amount. */
export async function verifyRazorpay(req, res) {
  const body = req.valid.body;
  const order = await Order.findOne({ orderNumber: body.orderNumber });
  if (!order || order.paymentMethod !== "razorpay") throw AppError.notFound("Order not found.");
  const payment = await Payment.findOne({ order: order._id, provider: "razorpay", providerOrderId: body.razorpayOrderId });
  if (!payment || !verifyCheckoutSignature(body)) throw new AppError(400, "PAYMENT_VERIFICATION_FAILED", "We couldn't verify this payment. If money was deducted, it will be confirmed automatically or refunded.");

  const rzp = getRazorpay();
  let p = await rzp.fetchPayment(body.razorpayPaymentId);
  if (p.order_id !== body.razorpayOrderId || p.currency !== "INR") throw new AppError(400, "PAYMENT_VERIFICATION_FAILED", "Payment does not belong to this order.");
  if (p.status === "authorized") p = await rzp.capturePayment(p.id, p.amount, p.currency);
  if (p.status !== "captured") throw new AppError(402, "PAYMENT_NOT_CAPTURED", "Your payment hasn't completed yet. We'll update your order as soon as it does.");

  const updated = await orders.markPaid(order, { providerPaymentId: p.id, method: p.method, details: paymentMethodDetails(p), amountPaise: p.amount, via: "checkout" });
  ok(res, { order: orders.customerOrderView(updated) });
}

/* POST /payments/webhook — Razorpay server-to-server events. Signed with the webhook secret over the raw body;
   each event id is processed once. Always answers 2xx for valid signatures so Razorpay stops retrying. */
export async function razorpayWebhook(req, res) {
  if (!verifyWebhookSignature(req.rawBody, req.get("x-razorpay-signature"))) throw new AppError(400, "INVALID_SIGNATURE", "Invalid webhook signature.");
  const event = req.body;
  const eventId = req.get("x-razorpay-event-id") || `${event.event}:${event.payload?.payment?.entity?.id || event.payload?.refund?.entity?.id || event.created_at}`;
  try {
    await WebhookEvent.create({ provider: "razorpay", eventId, type: event.event, payload: event });
  } catch (err) {
    if (err?.code === 11000) return ok(res, { duplicate: true });
    throw err;
  }

  const pay = event.payload?.payment?.entity;
  try {
    if ((event.event === "payment.captured" || event.event === "order.paid") && pay) {
      const record = await Payment.findOne({ provider: "razorpay", providerOrderId: pay.order_id });
      const order = record && (await Order.findById(record.order));
      if (order) await orders.markPaid(order, { providerPaymentId: pay.id, method: pay.method, details: paymentMethodDetails(pay), amountPaise: pay.amount, via: "webhook" });
    } else if (event.event === "payment.failed" && pay) {
      await orders.recordPaymentFailure(pay.order_id, { providerPaymentId: pay.id, ...paymentFailure(pay), method: pay.method, details: paymentMethodDetails(pay) });
    } else if (event.event?.startsWith("refund.")) {
      // refund.created / refund.processed / refund.failed — the refund entity carries the verified status.
      const r = event.payload?.refund?.entity;
      if (r) await orders.applyRefundStatus({ refundId: r.id, status: r.status, failureReason: r.error_description || r.notes?.failure_reason, via: "webhook" });
    }
    await WebhookEvent.updateOne({ provider: "razorpay", eventId }, { $set: { processedAt: new Date() } });
  } catch (err) {
    // Let Razorpay retry: forget the event so the retry is processed.
    await WebhookEvent.deleteOne({ provider: "razorpay", eventId });
    logger.error({ err: err?.message, eventId, type: event.event }, "Webhook processing failed");
    throw err;
  }
  ok(res, { received: true });
}
