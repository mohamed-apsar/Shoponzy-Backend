import crypto from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { API, app, browser, useDb } from "./helpers.js";
import { ADDRESS, CONTACT, adminBrowser, customerBrowser, key, mockRazorpay, simpleProduct } from "./fixtures.js";
import { Order, Payment } from "../src/models/commerce.js";

useDb();
let admin, rzp;
beforeEach(async () => { admin = await adminBrowser(); rzp = mockRazorpay(); });

function webhook(event, eventId = `evt_${crypto.randomBytes(4).toString("hex")}`) {
  const raw = JSON.stringify(event);
  const sig = crypto.createHmac("sha256", "test_webhook_secret").update(raw).digest("hex");
  return request(app).post(`${API}/payments/webhook`).set("Content-Type", "application/json").set("X-Razorpay-Signature", sig).set("X-Razorpay-Event-Id", eventId).send(raw);
}

async function onlineOrder({ price = 1000, contact = CONTACT } = {}) {
  const p = await simpleProduct({ price, stock: 20, name: `Item ${crypto.randomBytes(2).toString("hex")}` });
  const b = await browser();
  await b.post("/cart/items", { productId: String(p._id), variantId: String(p.variants[0]._id), qty: 1 }).expect(200);
  const res = await b.post("/orders", { contact, shippingAddress: ADDRESS, paymentMethod: "razorpay", idempotencyKey: key() }).expect(201);
  return { b, order: res.body.data.order, payment: res.body.data.payment };
}
async function paidOrder(opts = {}, payOpts = {}) {
  const o = await onlineOrder(opts);
  const pay = rzp.client.pay(o.payment.razorpayOrderId, payOpts);
  await o.b.post("/payments/razorpay/verify", { orderNumber: o.order.orderNumber, razorpayOrderId: o.payment.razorpayOrderId, razorpayPaymentId: pay.id, razorpaySignature: rzp.client.sign(o.payment.razorpayOrderId, pay.id) }).expect(200);
  return { ...o, pay };
}

describe("transactions & payments", () => {
  it("lists verified payments with method details, failure details and summary cards", async () => {
    const card = await paidOrder({ contact: { ...CONTACT, name: "Card Buyer", email: "card@example.com" } }, { method: "card", extra: { card: { network: "Visa", type: "debit", last4: "4242", issuer: "HDFC", number: "4111111111114242" } } });
    await paidOrder({}, { method: "upi" });
    const failed = await onlineOrder();
    const failedPay = { id: "pay_failed1", order_id: failed.payment.razorpayOrderId, method: "netbanking", bank: "HDFC", error_code: "BAD_REQUEST_ERROR", error_description: "Payment was cancelled by the customer", error_source: "customer", error_step: "payment_authentication", error_reason: "payment_cancelled" };
    await webhook({ event: "payment.failed", payload: { payment: { entity: failedPay } } }).expect(200);
    await onlineOrder(); // pending: checkout opened, never paid

    const res = (await admin.get("/admin/transactions").expect(200)).body;
    expect(res.meta.summary).toMatchObject({ totalTransactions: 4, successful: 2, failed: 1, pending: 1, totalAmount: 1900, totalRefunded: 0 });
    const byMethod = Object.fromEntries(res.meta.summary.byMethod.map((m) => [m.method, m]));
    expect(byMethod.card).toMatchObject({ total: 1, successful: 1, failed: 0, successRate: 100, amount: 950 });
    expect(byMethod.netbanking).toMatchObject({ total: 1, successful: 0, failed: 1, successRate: 0, amount: 0 });
    expect(byMethod.unknown).toMatchObject({ total: 1, successRate: null });

    const cardRow = res.data.find((t) => t.razorpayPaymentId === card.pay.id);
    expect(cardRow).toMatchObject({ status: "success", method: "card", amount: 950, customer: { name: "Card Buyer", email: "card@example.com" }, order: { orderNumber: card.order.orderNumber } });
    expect(cardRow.methodDetails).toEqual({ cardNetwork: "Visa", cardType: "debit", cardLast4: "4242", cardIssuer: "HDFC" });
    expect(JSON.stringify(res.data)).not.toContain("4111111111114242"); // full card numbers are never stored

    const failedRow = res.data.find((t) => t.status === "failed");
    expect(failedRow).toMatchObject({ method: "netbanking", methodDetails: { bank: "HDFC" }, failure: { description: "Payment was cancelled by the customer", source: "customer", reason: "payment_cancelled" } });

    // Filters & search.
    expect((await admin.get("/admin/transactions?status=success").expect(200)).body.meta.total).toBe(2);
    expect((await admin.get("/admin/transactions?status=pending").expect(200)).body.meta.total).toBe(1);
    expect((await admin.get("/admin/transactions?method=upi").expect(200)).body.meta.total).toBe(1);
    expect((await admin.get("/admin/transactions?q=card%40example").expect(200)).body.meta.total).toBe(1);
    expect((await admin.get(`/admin/transactions?q=${card.order.orderNumber}`).expect(200)).body.meta.total).toBe(1);
    expect((await admin.get(`/admin/transactions?q=${cardRow.id}`).expect(200)).body.data[0].id).toBe(cardRow.id);
    expect((await admin.get("/admin/transactions?from=2000-01-01&to=2000-01-31").expect(200)).body.meta.total).toBe(0);
    expect((await admin.get("/admin/transactions?sort=amount_high&status=success").expect(200)).body.data).toHaveLength(2);
    // The cards keep the full status split when a status filter is on.
    expect((await admin.get("/admin/transactions?status=failed").expect(200)).body.meta.summary.successful).toBe(2);
    await admin.get("/admin/transactions?method=cheque").expect(400);
    expect((await admin.get(`/admin/transactions/${cardRow.id}`).expect(200)).body.data.id).toBe(cardRow.id);
  });

  it("tracks refunds, refuses duplicates and exports filtered CSV reports", async () => {
    const { order, pay } = await paidOrder();
    rzp.client.refundStatus = "pending";
    // Two simultaneous full refunds: only one reaches Razorpay.
    const [a, b] = await Promise.all([
      admin.post(`/admin/orders/${order.id}/refund`, { reason: "Customer request" }),
      admin.post(`/admin/orders/${order.id}/refund`, { reason: "Customer request" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(rzp.refunds).toHaveLength(1);

    const refunds = (await admin.get("/admin/refunds").expect(200)).body;
    expect(refunds.data[0]).toMatchObject({ status: "pending", amount: 950, razorpayPaymentId: pay.id, order: { orderNumber: order.orderNumber }, by: { name: "Store Admin" } });
    let summary = (await admin.get("/admin/transactions/summary").expect(200)).body.data;
    expect(summary).toMatchObject({ totalRefunded: 0, refundsPending: { count: 1, amount: 950 } });

    await webhook({ event: "refund.processed", payload: { refund: { entity: { id: refunds.data[0].refundId, payment_id: pay.id, status: "processed" } } } }).expect(200);
    summary = (await admin.get("/admin/transactions/summary").expect(200)).body.data;
    expect(summary).toMatchObject({ totalRefunded: 950, refundsPending: { count: 0 } });
    const row = (await admin.get("/admin/transactions?status=refunded").expect(200)).body.data[0];
    expect(row).toMatchObject({ status: "refunded", refundedAmount: 950, refundStatus: "processed" });
    expect(row.refunds[0].processedAt).toBeTruthy();
    // A late capture webhook doesn't undo the refund.
    await webhook({ event: "payment.captured", payload: { payment: { entity: { ...pay, status: "captured" } } } }).expect(200);
    expect((await Payment.findOne({ providerPaymentId: pay.id }).lean()).status).toBe("refunded");
    expect((await Order.findById(order.id).lean()).paymentStatus).toBe("refunded");

    await paidOrder({ contact: { ...CONTACT, name: "=cmd|calc" } });
    const csv = await admin.get("/admin/transactions/export.csv?status=refunded").expect(200);
    const lines = csv.text.split("\n");
    expect(lines[0]).toBe("transaction_id,razorpay_payment_id,razorpay_order_id,order_id,customer,customer_email,amount,currency,payment_method,payment_status,refund_amount,refund_status,transaction_date");
    expect(lines).toHaveLength(2); // the filter applies to the export
    expect(lines[1]).toContain(`${pay.id},`);
    expect(lines[1]).toContain(",refunded,950,processed,");
    const all = (await admin.get("/admin/transactions/export.csv").expect(200)).text;
    expect(all).toContain("'=cmd|calc");
  });

  it("is admin-only, including exports", async () => {
    const customer = await customerBrowser();
    for (const path of ["/admin/transactions", "/admin/transactions/summary", "/admin/transactions/export.csv", "/admin/refunds"]) {
      await customer.get(path).expect(401);
      await (await browser()).get(path).expect(401);
    }
  });
});
