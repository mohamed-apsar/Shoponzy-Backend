import crypto from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { API, app, browser, useDb } from "./helpers.js";
import { ADDRESS, CONTACT, adminBrowser, key, mockRazorpay, simpleProduct } from "./fixtures.js";
import { Product } from "../src/models/Product.js";
import { InventoryMovement, Order, Payment, WebhookEvent } from "../src/models/commerce.js";
import { expireReservations } from "../src/services/orderService.js";

useDb();
let rzp;
beforeEach(() => { rzp = mockRazorpay(); });

const stockOf = async (p) => (await Product.findById(p._id)).variants[0].stock;

async function startOnlineCheckout({ price = 1000, qty = 1, stock = 5 } = {}) {
  const product = await simpleProduct({ price, stock });
  const b = await browser();
  await b.post("/cart/items", { productId: String(product._id), variantId: String(product.variants[0]._id), qty }).expect(200);
  const res = await b.post("/orders", { contact: CONTACT, shippingAddress: ADDRESS, paymentMethod: "razorpay", idempotencyKey: key() }).expect(201);
  return { b, product, order: res.body.data.order, payment: res.body.data.payment };
}

const verifyBody = (order, rzpOrderId, pay, signature) => ({
  orderNumber: order.orderNumber, razorpayOrderId: rzpOrderId, razorpayPaymentId: pay.id, razorpaySignature: signature ?? rzp.client.sign(rzpOrderId, pay.id),
});

function webhook(event, { secret = "test_webhook_secret", eventId = `evt_${crypto.randomBytes(4).toString("hex")}` } = {}) {
  const raw = JSON.stringify(event);
  const sig = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  return request(app).post(`${API}/payments/webhook`).set("Content-Type", "application/json").set("X-Razorpay-Signature", sig).set("X-Razorpay-Event-Id", eventId).send(raw);
}
const capturedEvent = (pay) => ({ event: "payment.captured", payload: { payment: { entity: pay } }, created_at: 1 });

describe("Razorpay checkout", () => {
  it("reserves stock, applies the prepaid discount and returns the Checkout payload", async () => {
    const { product, order, payment } = await startOnlineCheckout({ price: 1000 });
    expect(order).toMatchObject({ status: "pending_payment", paymentStatus: "pending", prepaidDiscount: 50, shippingFee: 0, total: 950 }); // ₹1000 ≥ ₹999 → free delivery; −5% prepaid
    expect(payment).toMatchObject({ provider: "razorpay", keyId: "rzp_test_mock", amount: 95000, currency: "INR", prefill: { contact: "9876543210" } });
    expect(rzp.orders.get(payment.razorpayOrderId)).toMatchObject({ amount: 95000, receipt: order.orderNumber });
    expect(await stockOf(product)).toBe(4);
    expect(new Date(order.reservationExpiresAt).getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
  });

  it("verifies the signature and the captured payment, then marks the order paid", async () => {
    const { b, order, payment } = await startOnlineCheckout();
    const pay = rzp.client.pay(payment.razorpayOrderId);
    const res = await b.post("/payments/razorpay/verify", verifyBody(order, payment.razorpayOrderId, pay)).expect(200);
    expect(res.body.data.order).toMatchObject({ status: "placed", paymentStatus: "paid" });
    expect(await Payment.findOne({ providerOrderId: payment.razorpayOrderId })).toMatchObject({ status: "captured", providerPaymentId: pay.id, method: "upi" });
    // Repeating the callback is harmless.
    await b.post("/payments/razorpay/verify", verifyBody(order, payment.razorpayOrderId, pay)).expect(200);
    expect((await Order.findOne({ orderNumber: order.orderNumber })).history.filter((h) => h.note?.startsWith("Payment received"))).toHaveLength(1);
  });

  it("rejects a forged signature, another order's payment, and an underpaid amount", async () => {
    const { b, order, payment } = await startOnlineCheckout();
    const pay = rzp.client.pay(payment.razorpayOrderId);
    await b.post("/payments/razorpay/verify", verifyBody(order, payment.razorpayOrderId, pay, "f".repeat(64))).expect(400);

    const other = await startOnlineCheckout();
    const otherPay = rzp.client.pay(other.payment.razorpayOrderId);
    // Valid signature for the other order, presented against this order:
    await b.post("/payments/razorpay/verify", verifyBody(order, other.payment.razorpayOrderId, otherPay)).expect(400);

    const cheap = rzp.client.pay(payment.razorpayOrderId, { amount: 100 });
    expect((await b.post("/payments/razorpay/verify", verifyBody(order, payment.razorpayOrderId, cheap)).expect(400)).body.error.code).toBe("AMOUNT_MISMATCH");
    expect((await Order.findOne({ orderNumber: order.orderNumber })).paymentStatus).toBe("pending");
  });

  it("captures authorized payments; a still-pending payment leaves the order unpaid", async () => {
    const { b, order, payment } = await startOnlineCheckout();
    const authorized = rzp.client.pay(payment.razorpayOrderId, { status: "authorized" });
    await b.post("/payments/razorpay/verify", verifyBody(order, payment.razorpayOrderId, authorized)).expect(200);
    expect((await Order.findOne({ orderNumber: order.orderNumber })).paymentStatus).toBe("paid");

    const second = await startOnlineCheckout();
    const pending = rzp.client.pay(second.payment.razorpayOrderId, { status: "created" });
    await second.b.post("/payments/razorpay/verify", verifyBody(second.order, second.payment.razorpayOrderId, pending)).expect(402);
  });

  it("if Razorpay is unreachable, releases stock, keeps the bag and reports the error", async () => {
    rzp.client.failCreate = true;
    const product = await simpleProduct({ stock: 5 });
    const b = await browser();
    await b.post("/cart/items", { productId: String(product._id), variantId: String(product.variants[0]._id), qty: 2 }).expect(200);
    const res = await b.post("/orders", { contact: CONTACT, shippingAddress: ADDRESS, paymentMethod: "razorpay" }).expect(502);
    expect(res.body.error.code).toBe("PAYMENT_GATEWAY_ERROR");
    expect(await stockOf(product)).toBe(5);
    expect((await b.get("/cart").expect(200)).body.data.lines[0].qty).toBe(2);
    expect(await Order.findOne()).toMatchObject({ status: "cancelled" });
  });
});

describe("Razorpay webhooks", () => {
  it("marks orders paid from payment.captured, once per event id", async () => {
    const { order, payment } = await startOnlineCheckout();
    const pay = rzp.client.pay(payment.razorpayOrderId);
    await webhook(capturedEvent(pay), { eventId: "evt_1" }).expect(200);
    expect((await Order.findOne({ orderNumber: order.orderNumber })).status).toBe("placed");
    const dup = await webhook(capturedEvent(pay), { eventId: "evt_1" }).expect(200);
    expect(dup.body.data).toEqual({ duplicate: true });
    expect(await WebhookEvent.countDocuments()).toBe(1);
  });

  it("rejects bad signatures and doesn't need a CSRF token", async () => {
    const { payment } = await startOnlineCheckout();
    const pay = rzp.client.pay(payment.razorpayOrderId);
    await webhook(capturedEvent(pay), { secret: "wrong" }).expect(400);
    await request(app).post(`${API}/payments/webhook`).send(capturedEvent(pay)).expect(400);
    expect(await WebhookEvent.countDocuments()).toBe(0);
  });

  it("records failed payments without cancelling (the shopper can retry until the reservation ends)", async () => {
    const { order, payment } = await startOnlineCheckout();
    const pay = rzp.client.pay(payment.razorpayOrderId, { status: "failed" });
    await webhook({ event: "payment.failed", payload: { payment: { entity: { ...pay, error_code: "BAD_REQUEST_ERROR", error_description: "Payment declined by bank" } } } }).expect(200);
    expect(await Payment.findOne({ providerOrderId: payment.razorpayOrderId })).toMatchObject({ status: "failed", errorDescription: "Payment declined by bank" });
    expect((await Order.findOne({ orderNumber: order.orderNumber })).status).toBe("pending_payment");
  });
});

describe("reservations", () => {
  const expire = (orderNumber) => Order.updateOne({ orderNumber }, { reservationExpiresAt: new Date(Date.now() - 1000) });

  it("unpaid orders are cancelled after the reservation window and stock is released", async () => {
    const { product, order } = await startOnlineCheckout({ qty: 2 });
    expect(await expireReservations()).toBe(0); // not due yet
    await expire(order.orderNumber);
    expect(await expireReservations()).toBe(1);
    expect(await Order.findOne({ orderNumber: order.orderNumber })).toMatchObject({ status: "cancelled", stockReserved: false });
    expect(await stockOf(product)).toBe(5);
    expect(await InventoryMovement.findOne({ reason: "reservation_expired" })).toMatchObject({ delta: 2 });
  });

  it("asks Razorpay before releasing: a captured payment whose webhook is late is honoured", async () => {
    const { product, order, payment } = await startOnlineCheckout();
    rzp.client.pay(payment.razorpayOrderId);
    await expire(order.orderNumber);
    expect(await expireReservations()).toBe(0);
    expect(await Order.findOne({ orderNumber: order.orderNumber })).toMatchObject({ status: "placed", paymentStatus: "paid" });
    expect(await stockOf(product)).toBe(4);
  });

  it("a payment arriving after release re-reserves stock, or flags a refund if it sold out", async () => {
    const first = await startOnlineCheckout({ stock: 1 });
    await expire(first.order.orderNumber);
    await expireReservations();
    const lateA = rzp.client.pay(first.payment.razorpayOrderId);
    await webhook(capturedEvent(lateA)).expect(200);
    expect(await Order.findOne({ orderNumber: first.order.orderNumber })).toMatchObject({ status: "placed", paymentStatus: "paid", stockReserved: true });
    expect(await stockOf(first.product)).toBe(0);

    const second = await startOnlineCheckout({ stock: 1 });
    await expire(second.order.orderNumber);
    await expireReservations();
    await Product.updateOne({ _id: second.product._id }, { $set: { "variants.0.stock": 0 } }); // someone else bought it
    const lateB = rzp.client.pay(second.payment.razorpayOrderId);
    await webhook(capturedEvent(lateB)).expect(200);
    const o = await Order.findOne({ orderNumber: second.order.orderNumber });
    expect(o).toMatchObject({ status: "cancelled", paymentStatus: "paid", refundRequired: true });
    expect(o.needsAttention).toMatch(/out of stock/);
  });
});

describe("refunds", () => {
  it("admins refund partially then fully through Razorpay; customers can't", async () => {
    const { b, order, payment } = await startOnlineCheckout({ price: 2000 }); // total 1900 (free shipping, 5% off)
    const pay = rzp.client.pay(payment.razorpayOrderId);
    await b.post("/payments/razorpay/verify", verifyBody(order, payment.razorpayOrderId, pay)).expect(200);
    const id = (await Order.findOne({ orderNumber: order.orderNumber }))._id;
    await b.post(`/admin/orders/${id}/refund`, { amount: 100 }).expect(401);

    const admin = await adminBrowser();
    let res = await admin.post(`/admin/orders/${id}/refund`, { amount: 400, reason: "Damaged box" }).expect(200);
    expect(res.body.data.order).toMatchObject({ paymentStatus: "partially_refunded", refundedAmount: 400 });
    expect(rzp.refunds[0]).toMatchObject({ payment_id: pay.id, amount: 40000 });
    await admin.post(`/admin/orders/${id}/refund`, { amount: 5000 }).expect(400);
    res = await admin.post(`/admin/orders/${id}/refund`, {}).expect(200);
    expect(res.body.data.order).toMatchObject({ paymentStatus: "refunded", refundedAmount: 1900 });
    expect(await Payment.findOne({ providerPaymentId: pay.id })).toMatchObject({ status: "refunded", refundedAmount: 1900 });
    await admin.post(`/admin/orders/${id}/refund`, {}).expect(409);
  });

  it("cancelling a paid order flags it for refund; gateway refund errors are reported", async () => {
    const { b, order, payment } = await startOnlineCheckout();
    const pay = rzp.client.pay(payment.razorpayOrderId);
    await b.post("/payments/razorpay/verify", verifyBody(order, payment.razorpayOrderId, pay)).expect(200);
    const cancelled = (await b.post(`/orders/${order.orderNumber}/cancel`, {}).expect(200)).body.data;
    expect(cancelled).toMatchObject({ status: "cancelled", paymentStatus: "paid", refundRequired: true });
    const admin = await adminBrowser();
    expect((await admin.get("/admin/orders?attention=1").expect(200)).body.meta.total).toBe(1);
    rzp.client.failRefund = true;
    const id = (await Order.findOne({ orderNumber: order.orderNumber }))._id;
    expect((await admin.post(`/admin/orders/${id}/refund`, {}).expect(502)).body.error.code).toBe("REFUND_FAILED");
  });
});
