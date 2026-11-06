import crypto from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { API, app, browser, useDb } from "./helpers.js";
import { ADDRESS, CONTACT, adminBrowser, customerBrowser, key, mockCloudinary, mockRazorpay, simpleProduct, sneaker, variantOf } from "./fixtures.js";
import { Product } from "../src/models/Product.js";
import { InventoryMovement, Order, Payment, ReturnRequest } from "../src/models/commerce.js";
import { SiteSetting } from "../src/models/site.js";

useDb();
let admin, rzp;
beforeEach(async () => { admin = await adminBrowser(); rzp = mockRazorpay(); });

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const stockOf = async (productId, variantId) => (await Product.findById(productId)).variants.id(variantId).stock;

async function deliver(orderId) {
  await admin.patch(`/admin/orders/${orderId}/status`, { status: "shipped" }).expect(200);
  await admin.patch(`/admin/orders/${orderId}/status`, { status: "delivered" }).expect(200);
}

/* A delivered order: 2 × wallet (₹500) + 1 × sneaker (₹1000) = ₹2000, free delivery. */
async function deliveredOrder({ method = "cod", shopper } = {}) {
  const wallet = await simpleProduct({ name: `Wallet ${crypto.randomBytes(2).toString("hex")}`, price: 500, stock: 10 });
  const shoe = await sneaker({ price: 1000, stock: 5 });
  const shoeVariant = variantOf(shoe, "White", "8");
  const b = shopper || (await customerBrowser());
  await b.post("/cart/items", { productId: String(wallet._id), variantId: String(wallet.variants[0]._id), qty: 2 }).expect(200);
  await b.post("/cart/items", { productId: String(shoe._id), variantId: String(shoeVariant._id), qty: 1 }).expect(200);
  const res = await b.post("/orders", { contact: CONTACT, shippingAddress: ADDRESS, paymentMethod: method, idempotencyKey: key() }).expect(201);
  let order = res.body.data.order;
  if (method === "razorpay") {
    const { razorpayOrderId } = res.body.data.payment;
    const pay = rzp.client.pay(razorpayOrderId, { method: "card", extra: { card: { network: "Visa", type: "credit", last4: "1111", issuer: "HDFC" } } });
    await b.post("/payments/razorpay/verify", { orderNumber: order.orderNumber, razorpayOrderId, razorpayPaymentId: pay.id, razorpaySignature: rzp.client.sign(razorpayOrderId, pay.id) }).expect(200);
  }
  await deliver(order.id);
  order = await Order.findById(order.id).lean();
  return { b, order, wallet, shoe, walletVariant: wallet.variants[0], shoeVariant };
}

const requestReturn = (b, order, body) => b.post(`/orders/${order.orderNumber}/returns`, body);

describe("customer return requests", () => {
  it("only delivered orders within the return window can be returned, for what was bought", async () => {
    const b = await customerBrowser();
    const p = await simpleProduct({ stock: 5 });
    await b.post("/cart/items", { productId: String(p._id), variantId: String(p.variants[0]._id), qty: 1 }).expect(200);
    const placed = (await b.post("/orders", { contact: CONTACT, shippingAddress: ADDRESS, paymentMethod: "cod", idempotencyKey: key() }).expect(201)).body.data.order;
    const early = (await b.get(`/orders/${placed.orderNumber}/returns`).expect(200)).body.data.eligibility;
    expect(early).toMatchObject({ eligible: false, returnDays: 7 });
    await requestReturn(b, placed, { items: [{ variantId: String(p.variants[0]._id), qty: 1 }], reason: "damaged" }).expect(409);

    const { order, walletVariant, shoeVariant } = await deliveredOrder({ shopper: b });
    const elig = (await b.get(`/orders/${order.orderNumber}/returns`).expect(200)).body.data.eligibility;
    expect(elig).toMatchObject({ eligible: true });
    expect(elig.items.map((i) => i.returnable)).toEqual([2, 1]);

    await requestReturn(b, order, { items: [{ variantId: String(walletVariant._id), qty: 3 }], reason: "damaged" }).expect(400); // more than bought
    await requestReturn(b, order, { items: [{ variantId: String(crypto.randomBytes(12).toString("hex")), qty: 1 }], reason: "damaged" }).expect(400);
    await requestReturn(b, order, { items: [{ variantId: String(walletVariant._id), qty: 1 }], reason: "other" }).expect(400); // "other" needs a comment
    await requestReturn(b, order, { items: [{ variantId: String(walletVariant._id), qty: 1 }], reason: "bogus" }).expect(400);

    const created = (await requestReturn(b, order, { items: [{ variantId: String(walletVariant._id), qty: 1 }], reason: "size_fit", comments: "Too small" }).expect(201)).body.data;
    expect(created).toMatchObject({ returnNumber: "RT100001", status: "requested", reason: "size_fit", comments: "Too small", refund: { status: "not_applicable" } });
    expect(created.guestId).toBeUndefined();
    // Partial returns: the remaining wallet and the shoe can still be returned.
    const after = (await b.get(`/orders/${order.orderNumber}/returns`).expect(200)).body.data;
    expect(after.eligibility.items.map((i) => i.returnable)).toEqual([1, 1]);
    expect(after.returns).toHaveLength(1);
    await requestReturn(b, order, { items: [{ variantId: String(walletVariant._id), qty: 1 }, { variantId: String(shoeVariant._id), qty: 1 }], reason: "changed_mind" }).expect(201);
    await requestReturn(b, order, { items: [{ variantId: String(walletVariant._id), qty: 1 }], reason: "changed_mind" }).expect(409); // nothing left

    // Requesting a return changes no stock.
    expect(await stockOf(order.items[0].product, walletVariant._id)).toBe(8);

    // The window closes after returnDays.
    await SiteSetting.updateOne({ key: "commerce" }, { $set: { value: { returnDays: 7 } } }, { upsert: true });
    await Order.updateOne({ _id: order._id }, { $set: { "fulfilment.deliveredAt": new Date(Date.now() - 8 * 86_400_000) } });
    expect((await b.get(`/orders/${order.orderNumber}/returns`).expect(200)).body.data.eligibility.eligible).toBe(false);
  });

  it("other shoppers can't see or return someone else's order; customers can cancel a pending request", async () => {
    const { b, order, walletVariant } = await deliveredOrder();
    const stranger = await customerBrowser();
    await stranger.get(`/orders/${order.orderNumber}/returns`).expect(404);
    await requestReturn(stranger, order, { items: [{ variantId: String(walletVariant._id), qty: 1 }], reason: "damaged" }).expect(404);
    await (await browser()).get(`/orders/${order.orderNumber}/returns`).expect(404);

    const rr = (await requestReturn(b, order, { items: [{ variantId: String(walletVariant._id), qty: 1 }], reason: "damaged" }).expect(201)).body.data;
    await stranger.post(`/returns/${rr.returnNumber}/cancel`, {}).expect(404);
    expect((await b.post(`/returns/${rr.returnNumber}/cancel`, {}).expect(200)).body.data.status).toBe("cancelled");
    await b.post(`/returns/${rr.returnNumber}/cancel`, {}).expect(409);
  });

  it("evidence photos go to returns/return-evidence, only for customers with a delivered order", async () => {
    const cloud = mockCloudinary();
    const nobody = await customerBrowser();
    await nobody.agent.post(`${API}/returns/uploads`).set("X-CSRF-Token", nobody.token).attach("file", png, "a.png").expect(403);

    const { b, order, walletVariant } = await deliveredOrder();
    const up = (await b.agent.post(`${API}/returns/uploads`).set("X-CSRF-Token", b.token).attach("file", png, "a.png").expect(201)).body.data;
    expect(up.publicId.startsWith("shoponzy/returns/return-evidence/")).toBe(true);
    // Admin-panel images can't be passed off as evidence.
    const adminUp = (await admin.agent.post(`${API}/admin/uploads`).set("X-CSRF-Token", admin.token).field("kind", "product").attach("file", png, "a.png").expect(201)).body.data;
    await requestReturn(b, order, { items: [{ variantId: String(walletVariant._id), qty: 1 }], reason: "damaged", evidence: [{ publicId: adminUp.publicId }] }).expect(400);
    const rr = (await requestReturn(b, order, { items: [{ variantId: String(walletVariant._id), qty: 1 }], reason: "damaged", evidence: [{ publicId: up.publicId }] }).expect(201)).body.data;
    expect(rr.evidence).toEqual([{ url: up.url }]);
    expect(cloud.uploaded.size).toBe(2);
    // No CSRF token → refused.
    await request(app).post(`${API}/returns/uploads`).attach("file", png, "a.png").expect(403);
  });
});

describe("return reasons", () => {
  it("admins add, rename and disable reasons; customers see and use the active ones", async () => {
    const { b, order, walletVariant } = await deliveredOrder();
    const initial = (await admin.get("/admin/returns/reasons").expect(200)).body.data;
    expect(initial.map((r) => r.code)).toEqual(["damaged", "wrong_item", "defective", "size_fit", "not_as_described", "missing_items", "changed_mind", "other"]);

    const next = initial.map((r) => (r.code === "changed_mind" ? { ...r, active: false } : r.code === "damaged" ? { ...r, label: "Arrived damaged" } : r));
    const saved = (await admin.put("/admin/returns/reasons", { reasons: [...next.map(({ used: _u, ...r }) => r), { label: "Colour differs from photos", requiresComment: true }] }).expect(200)).body.data;
    const added = saved.find((r) => r.label === "Colour differs from photos");
    expect(added).toMatchObject({ code: "colour_differs_from_photos", active: true, requiresComment: true, used: 0 });

    const offered = (await b.get(`/orders/${order.orderNumber}/returns`).expect(200)).body.data.eligibility.reasons;
    expect(offered.map((r) => r.code)).not.toContain("changed_mind");
    expect(offered.find((r) => r.code === "damaged").label).toBe("Arrived damaged");
    await requestReturn(b, order, { items: [{ variantId: String(walletVariant._id), qty: 1 }], reason: "changed_mind" }).expect(400); // disabled
    await requestReturn(b, order, { items: [{ variantId: String(walletVariant._id), qty: 1 }], reason: added.code }).expect(400); // needs a comment
    const rr = (await requestReturn(b, order, { items: [{ variantId: String(walletVariant._id), qty: 1 }], reason: added.code, comments: "Looks blue, not black" }).expect(201)).body.data;
    expect(rr.reasonLabel).toBe("Colour differs from photos");

    // A reason in use can be renamed (old requests keep their label) or disabled, but not deleted.
    const withRename = saved.map(({ used: _u, ...r }) => (r.code === added.code ? { ...r, label: "Colour mismatch" } : r));
    await admin.put("/admin/returns/reasons", { reasons: withRename }).expect(200);
    expect((await admin.get(`/admin/returns/${rr.id}`).expect(200)).body.data.reasonLabel).toBe("Colour differs from photos");
    expect((await admin.put("/admin/returns/reasons", { reasons: withRename.filter((r) => r.code !== added.code) }).expect(409)).body.error.message).toMatch(/Disable it instead/);
    expect((await admin.get(`/admin/returns?reason=${added.code}`).expect(200)).body.meta.total).toBe(1);
    expect((await admin.get("/admin/returns/reasons").expect(200)).body.data.find((r) => r.code === added.code).used).toBe(1);

    // Guard rails.
    await admin.put("/admin/returns/reasons", { reasons: withRename.map((r) => ({ ...r, active: false })) }).expect(400);
    await admin.put("/admin/returns/reasons", { reasons: [...withRename, { label: "Colour mismatch" }] }).expect(400); // duplicate name
    await admin.put("/admin/returns/reasons", { reasons: [] }).expect(400);
    // Reasons are admin-only: not in the public settings.
    expect((await (await browser()).get("/site-settings").expect(200)).body.data.returns).toBeUndefined();
    await (await customerBrowser()).put("/admin/returns/reasons", { reasons: withRename }).expect(401);
  });
});

describe("admin return workflow", () => {
  it("approve → receive → inspect (restock) → refund (COD manual) → complete", async () => {
    const { b, order, walletVariant, shoeVariant } = await deliveredOrder();
    const rr = (await requestReturn(b, order, { items: [{ variantId: String(walletVariant._id), qty: 2 }, { variantId: String(shoeVariant._id), qty: 1 }], reason: "defective", comments: "Stitching came apart" }).expect(201)).body.data;
    const url = `/admin/returns/${rr.id}`;

    const list = (await admin.get("/admin/returns?q=stitch").expect(200)).body;
    expect(list.meta.total).toBe(0); // comments aren't searched; names, numbers and SKUs are
    expect((await admin.get(`/admin/returns?q=${order.orderNumber}`).expect(200)).body.data[0]).toMatchObject({ returnNumber: rr.returnNumber, quantity: 3, status: "requested", customer: { name: CONTACT.name } });

    // Refunds and inspection aren't possible before approval/receipt.
    await admin.post(`${url}/refund`, { manualReference: "UTR1" }).expect(409);
    await admin.post(`${url}/status`, { status: "received" }).expect(409);
    await admin.post(`${url}/inspect`, { items: [{ index: 0, condition: "good", restockQty: 2 }, { index: 1, condition: "good", restockQty: 1 }] }).expect(409);

    const approved = (await admin.post(`${url}/approve`, { note: "Looks genuine" }).expect(200)).body.data;
    expect(approved).toMatchObject({ status: "approved", adminNote: "Looks genuine", decidedBy: { name: "Store Admin" }, refund: { status: "pending", amount: 2000, maxAmount: 2000 } });
    await admin.post(`${url}/approve`, {}).expect(409); // already decided
    await admin.post(`${url}/status`, { status: "pickup_scheduled", pickup: { courier: "Delhivery", trackingNumber: "DLV1" } }).expect(200);
    await admin.post(`${url}/status`, { status: "in_transit" }).expect(200);
    // Approval and transit leave stock untouched.
    expect(await stockOf(order.items[0].product, walletVariant._id)).toBe(8);
    const received = (await admin.post(`${url}/status`, { status: "received" }).expect(200)).body.data;
    expect(received.receivedAt).toBeTruthy();
    await admin.post(`${url}/refund`, { manualReference: "UTR1" }).expect(409); // inspect first

    await admin.post(`${url}/inspect`, { items: [{ index: 0, condition: "good", restockQty: 3 }, { index: 1, condition: "good", restockQty: 0 }] }).expect(400); // more than returned
    await admin.post(`${url}/inspect`, { items: [{ index: 0, condition: "good", restockQty: 2 }, { index: 1, condition: "unsellable", restockQty: 1 }] }).expect(400);
    await admin.post(`${url}/inspect`, { items: [{ index: 0, condition: "good", restockQty: 2 }] }).expect(400); // every item
    const inspected = (await admin.post(`${url}/inspect`, { items: [{ index: 0, condition: "good", restockQty: 2 }, { index: 1, condition: "damaged", restockQty: 0 }], notes: "Shoe sole torn" }).expect(200)).body.data;
    expect(inspected).toMatchObject({ status: "inspected", inspectionNotes: "Shoe sole torn", inspectedBy: { name: "Store Admin" } });
    expect(inspected.items.map((i) => [i.condition, i.restockedQty])).toEqual([["good", 2], ["damaged", 0]]);
    expect(await stockOf(order.items[0].product, walletVariant._id)).toBe(10);
    expect(await InventoryMovement.findOne({ reason: "return" }).lean()).toMatchObject({ delta: 2, before: 8, after: 10, returnRequest: rr.id ? expect.anything() : undefined });

    await admin.post(`${url}/status`, { status: "completed" }).expect(409); // refund outstanding
    await admin.post(`${url}/refund`, {}).expect(400); // COD needs the bank/UPI reference
    await admin.post(`${url}/refund`, { amount: 2500, manualReference: "UTR1" }).expect(400); // more than paid
    const refunded = (await admin.post(`${url}/refund`, { amount: 1500, manualReference: "UTR123" }).expect(200)).body.data;
    expect(refunded.refund).toMatchObject({ status: "completed", amount: 1500, refundId: "UTR123" });
    await admin.post(`${url}/refund`, { manualReference: "UTR124" }).expect(409); // never twice
    expect(await Order.findById(order._id).lean()).toMatchObject({ refundedAmount: 1500, paymentStatus: "partially_refunded" });

    const done = (await admin.post(`${url}/status`, { status: "completed" }).expect(200)).body.data;
    expect(done.status).toBe("completed");
    // Every unit came back, so the order is marked returned — without restocking again.
    expect((await Order.findById(order._id).lean()).status).toBe("returned");
    expect(await stockOf(order.items[0].product, walletVariant._id)).toBe(10);
    expect(done.history.map((h) => h.status || h.refundStatus)).toEqual(["requested", "approved", "pickup_scheduled", "in_transit", "received", "inspected", "completed", "completed"]);

    const summary = (await admin.get("/admin/returns/summary").expect(200)).body.data;
    expect(summary).toMatchObject({ total: 1, pending: 0, approved: 1, rejected: 0, productsReturned: 3, unitsRestocked: 2, refundsCompleted: 1, refundedAmount: 1500 });
    const items = (await admin.get("/admin/returns/items").expect(200)).body;
    expect(items.meta.total).toBe(2);
    expect(items.data[1]).toMatchObject({ condition: "damaged", restockedQty: 0, status: "completed", inspectionNotes: "Shoe sole torn" });
  });

  it("rejection needs a reason and confirms nothing is refunded or restocked", async () => {
    const { b, order, walletVariant } = await deliveredOrder();
    const rr = (await requestReturn(b, order, { items: [{ variantId: String(walletVariant._id), qty: 1 }], reason: "changed_mind" }).expect(201)).body.data;
    await admin.post(`/admin/returns/${rr.id}/reject`, {}).expect(400);
    const rejected = (await admin.post(`/admin/returns/${rr.id}/reject`, { reason: "Outside policy: item used" }).expect(200)).body.data;
    expect(rejected).toMatchObject({ status: "rejected", rejectionReason: "Outside policy: item used", refund: { status: "not_applicable" } });
    await admin.post(`/admin/returns/${rr.id}/approve`, {}).expect(409);
    expect((await b.get(`/orders/${order.orderNumber}/returns`).expect(200)).body.data.returns[0]).toMatchObject({ status: "rejected", rejectionReason: "Outside policy: item used" });
    // A rejected request frees the items for a new request.
    expect((await b.get(`/orders/${order.orderNumber}/returns`).expect(200)).body.data.eligibility.items[0].returnable).toBe(2);
    expect((await admin.get("/admin/returns?status=rejected").expect(200)).body.meta.total).toBe(1);
  });

  it("Razorpay refunds stay processing until Razorpay confirms them (webhook or sync), and failures can be retried", async () => {
    const { b, order, walletVariant } = await deliveredOrder({ method: "razorpay" });
    expect(order.total).toBe(1900); // 5% prepaid discount
    const rr = (await requestReturn(b, order, { items: [{ variantId: String(walletVariant._id), qty: 2 }], reason: "wrong_item" }).expect(201)).body.data;
    const url = `/admin/returns/${rr.id}`;
    await admin.post(`${url}/approve`, {}).expect(200);
    await admin.post(`${url}/status`, { status: "received" }).expect(200);
    await admin.post(`${url}/inspect`, { items: [{ index: 0, condition: "opened", restockQty: 2 }] }).expect(200);

    const detail = (await admin.get(url).expect(200)).body.data;
    expect(detail.refund).toMatchObject({ status: "pending", maxAmount: 950 }); // ₹1000 of ₹2000 lines, less half the ₹100 prepaid discount
    expect(detail.refund.originalPaymentId).toMatch(/^pay_/);
    expect(detail.refund.originalTransactionId).toBeTruthy();

    // Razorpay rejecting the call outright: nothing is refunded, the return shows the failure and can be retried.
    rzp.client.failRefund = true;
    expect((await admin.post(`${url}/refund`, {}).expect(502)).body.error.code).toBe("REFUND_FAILED");
    expect((await admin.get(url).expect(200)).body.data.refund).toMatchObject({ status: "failed", failureReason: expect.stringMatching(/Refund amount exceeds/) });
    expect((await Order.findById(order._id).lean()).refundedAmount).toBe(0);
    rzp.client.failRefund = false;

    rzp.client.refundStatus = "pending";
    const first = (await admin.post(`${url}/refund`, {}).expect(200)).body.data;
    expect(first.refund).toMatchObject({ status: "processing", amount: 950 });
    await admin.post(`${url}/refund`, {}).expect(409);
    await admin.post(`${url}/status`, { status: "completed" }).expect(409); // still processing

    // Razorpay reports the refund failed: the amount goes back to refundable and the return can be retried.
    const refundId = first.refund.refundId;
    await webhook({ event: "refund.failed", payload: { refund: { entity: { id: refundId, payment_id: detail.refund.originalPaymentId, status: "failed", amount: 95000 } } } }).expect(200);
    expect((await admin.get(url).expect(200)).body.data.refund).toMatchObject({ status: "failed" });
    expect(await Order.findById(order._id).lean()).toMatchObject({ refundedAmount: 0, paymentStatus: "paid", refundRequired: true });
    expect((await Payment.findOne({ order: order._id }).lean()).refunds[0]).toMatchObject({ status: "failed", refundId });

    rzp.client.refundStatus = "pending";
    const retry = (await admin.post(`${url}/refund`, {}).expect(200)).body.data;
    expect(retry.refund.status).toBe("processing");
    // Missed webhook: sync asks Razorpay directly.
    rzp.refunds.find((r) => r.id === retry.refund.refundId).status = "processed";
    const txId = detail.refund.originalTransactionId;
    expect((await admin.post(`/admin/transactions/${txId}/refunds/${retry.refund.refundId}/sync`, {}).expect(200)).body.data).toMatchObject({ status: "processed", changed: true });
    expect((await admin.get(url).expect(200)).body.data.refund).toMatchObject({ status: "completed", amount: 950 });
    await admin.post(`${url}/status`, { status: "completed" }).expect(200);
    // Only part of the order was returned: it stays delivered.
    expect((await Order.findById(order._id).lean())).toMatchObject({ status: "delivered", refundedAmount: 950, paymentStatus: "partially_refunded" });
  });

  it("is admin-only", async () => {
    const customer = await customerBrowser();
    for (const path of ["/admin/returns", "/admin/returns/summary", "/admin/returns/items"]) await customer.get(path).expect(401);
    const rr = await ReturnRequest.create({ returnNumber: "RT1", order: (await Order.create({ orderNumber: "SZ1", contact: { name: "A", phone: "9876543210" }, total: 1, paymentMethod: "cod", status: "delivered" }))._id, orderNumber: "SZ1", reason: "damaged", items: [{ name: "x", qty: 1, price: 1 }] });
    await customer.post(`/admin/returns/${rr._id}/approve`, {}).expect(401);
    expect((await ReturnRequest.findById(rr._id)).status).toBe("requested");
  });
});

function webhook(event, eventId = `evt_${crypto.randomBytes(4).toString("hex")}`) {
  const raw = JSON.stringify(event);
  const sig = crypto.createHmac("sha256", "test_webhook_secret").update(raw).digest("hex");
  return request(app).post(`${API}/payments/webhook`).set("Content-Type", "application/json").set("X-Razorpay-Signature", sig).set("X-Razorpay-Event-Id", eventId).send(raw);
}
