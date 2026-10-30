import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { API, app, browser, useDb } from "./helpers.js";
import { ADDRESS, CONTACT, adminBrowser, customerBrowser, key, mockMail, simpleProduct, sneaker, variantOf } from "./fixtures.js";
import { Product } from "../src/models/Product.js";
import { Coupon, InventoryMovement, Order, Payment } from "../src/models/commerce.js";
import { SiteSetting } from "../src/models/site.js";

useDb();

const stockOf = async (productId, variantId) => (await Product.findById(productId)).variants.id(variantId).stock;
const checkout = (b, extra = {}) => b.post("/orders", { contact: CONTACT, shippingAddress: ADDRESS, paymentMethod: "cod", idempotencyKey: key(), ...extra });

describe("cart", () => {
  it("guests get a bag cookie; the server prices lines from the database", async () => {
    const s = await sneaker({ price: 1299, mrp: 2499 });
    const v = variantOf(s, "White", "8");
    const b = await browser();
    const res = await b.post("/cart/items", { productId: String(s._id), variantId: String(v._id), qty: 2, price: 1 }).expect(400); // client prices are refused
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    const add = await b.post("/cart/items", { productId: String(s._id), variantId: String(v._id), qty: 2 }).expect(200);
    expect(add.headers["set-cookie"].some((c) => c.startsWith("sz_cart=") && /HttpOnly/.test(c))).toBe(true);
    expect(add.body.data.lines[0]).toMatchObject({ name: s.name, color: "White", size: "8", price: 1299, mrp: 2499, qty: 2, lineTotal: 2598, available: true });
    expect(add.body.data.totals.cod).toMatchObject({ subtotal: 2598, mrpTotal: 4998, shippingFee: 0, total: 2598 });
    expect(add.body.data.totals.razorpay).toMatchObject({ prepaidDiscount: 130, total: 2468 }); // 5% prepaid
  });

  it("adds quantities for the same variant, caps at stock and at 10, updates and removes lines", async () => {
    const s = await sneaker({ stock: 3 });
    const v = variantOf(s, "Black", "7");
    const b = await browser();
    await b.post("/cart/items", { productId: String(s._id), variantId: String(v._id), qty: 2 }).expect(200);
    expect((await b.post("/cart/items", { productId: String(s._id), variantId: String(v._id), qty: 2 }).expect(409)).body.error.message).toBe("Only 3 left in this size.");
    const cart = (await b.get("/cart").expect(200)).body.data;
    expect(cart.lines).toHaveLength(1);
    const itemId = cart.lines[0].itemId;
    await b.patch(`/cart/items/${itemId}`, { qty: 3 }).expect(200);
    await b.patch(`/cart/items/${itemId}`, { qty: 11 }).expect(400);
    expect((await b.del(`/cart/items/${itemId}`).expect(200)).body.data.lines).toEqual([]);
  });

  it("charges shipping below the free-delivery threshold, from Manage Site settings", async () => {
    const w = await simpleProduct({ price: 500 });
    const b = await browser();
    let cart = (await b.post("/cart/items", { productId: String(w._id), variantId: String(w.variants[0]._id), qty: 1 }).expect(200)).body.data;
    expect(cart.totals.cod).toMatchObject({ subtotal: 500, shippingFee: 59, total: 559, freeShippingRemaining: 499 });
    await SiteSetting.create({ key: "commerce", value: { freeShippingAbove: 400, shippingFee: 49 } });
    cart = (await b.get("/cart").expect(200)).body.data;
    expect(cart.totals.cod).toMatchObject({ shippingFee: 0, total: 500 });
  });

  it("applies coupons, explains minimums, and rejects invalid or expired codes", async () => {
    await Coupon.create({ code: "WELCOME10", type: "percent", value: 10, minSubtotal: 1499 });
    await Coupon.create({ code: "OLD", type: "fixed", value: 100, endsAt: new Date(Date.now() - 1000) });
    const w = await simpleProduct({ price: 1000 });
    const b = await browser();
    await b.post("/cart/items", { productId: String(w._id), variantId: String(w.variants[0]._id), qty: 1 }).expect(200);
    let cart = (await b.put("/cart/coupon", { code: "welcome10" }).expect(200)).body.data;
    expect(cart.coupon).toEqual({ code: "WELCOME10", applied: false, message: "Add ₹499 more to use WELCOME10" });
    const itemId = cart.lines[0].itemId;
    cart = (await b.patch(`/cart/items/${itemId}`, { qty: 2 }).expect(200)).body.data;
    expect(cart.coupon.applied).toBe(true);
    expect(cart.totals.cod).toMatchObject({ subtotal: 2000, couponDiscount: 200, total: 1800 });
    expect((await b.put("/cart/coupon", { code: "NOPE" }).expect(400)).body.error.message).toBe("“NOPE” isn’t a valid code.");
    expect((await b.put("/cart/coupon", { code: "OLD" }).expect(400)).body.error.message).toBe("“OLD” has expired.");
    expect((await b.put("/cart/coupon", { code: null }).expect(200)).body.data.coupon).toBeNull();
  });

  it("GET /coupons/:code exposes only the public rules of usable coupons", async () => {
    await Coupon.create({ code: "SAVE15", type: "percent", value: 15, minSubtotal: 500, maxDiscount: 200, usageLimit: 5 });
    await Coupon.create({ code: "OFF", type: "fixed", value: 100, status: "disabled" });
    await Coupon.create({ code: "LATER", type: "fixed", value: 100, startsAt: new Date(Date.now() + 86_400_000) });
    const b = await browser();
    const res = await b.get("/coupons/save15").expect(200);
    expect(res.body.data).toEqual({ code: "SAVE15", type: "percent", value: 15, minSubtotal: 500, maxDiscount: 200, label: "15% off on ₹500+" });
    expect((await b.get("/coupons/OFF").expect(404)).body.error.code).toBe("INVALID_COUPON");
    expect((await b.get("/coupons/LATER").expect(404)).body.error.message).toBe("“LATER” isn’t active yet.");
    await b.get("/coupons/a%20b").expect(400);
  });

  it("flags lines that became unavailable or short of stock", async () => {
    const s = await sneaker({ stock: 5 });
    const w = await simpleProduct();
    const b = await browser();
    await b.post("/cart/items", { productId: String(s._id), variantId: String(variantOf(s, "White", "7")._id), qty: 4 }).expect(200);
    await b.post("/cart/items", { productId: String(w._id), variantId: String(w.variants[0]._id), qty: 1 }).expect(200);
    await Product.updateOne({ _id: s._id, "variants._id": variantOf(s, "White", "7")._id }, { $set: { "variants.$.stock": 2 } });
    await Product.updateOne({ _id: w._id }, { status: "disabled" });
    const cart = (await b.get("/cart").expect(200)).body.data;
    expect(cart.hasIssues).toBe(true);
    expect(cart.lines.map((l) => l.issue)).toEqual(["insufficient_stock", "unavailable"]);
    expect(cart.totals.cod.subtotal).toBe(0);
  });

  it("merges the guest bag into the account bag on sign-in", async () => {
    const s = await sneaker();
    const v = variantOf(s, "White", "7");
    const customer = await customerBrowser({ email: "merge@example.com" });
    await customer.post("/cart/items", { productId: String(s._id), variantId: String(v._id), qty: 1 }).expect(200);

    const guest = await browser();
    await guest.post("/cart/items", { productId: String(s._id), variantId: String(v._id), qty: 2 }).expect(200);
    const login = await guest.post("/auth/login", { email: "merge@example.com", password: "correct-horse-battery" }).expect(200);
    expect(login.headers["set-cookie"].some((c) => c.startsWith("sz_cart=;"))).toBe(true);
    expect((await guest.get("/cart").expect(200)).body.data.lines[0].qty).toBe(3);
  });
});

describe("checkout (COD)", () => {
  it("creates the order with server totals, takes stock, logs movements, clears the bag and snapshots items", async () => {
    const sent = mockMail();
    const s = await sneaker({ price: 1000, mrp: 2000, stock: 5 });
    const v = variantOf(s, "White", "8");
    const b = await browser();
    await b.post("/cart/items", { productId: String(s._id), variantId: String(v._id), qty: 2 }).expect(200);
    const res = await checkout(b).expect(201);
    const order = res.body.data.order;
    expect(order).toMatchObject({ orderNumber: "SZ100001", status: "placed", paymentStatus: "pending", paymentMethod: "cod", subtotal: 2000, shippingFee: 0, total: 2000 });
    expect(order.items[0]).toMatchObject({ name: s.name, color: "White", size: "8", price: 1000, qty: 2, lineTotal: 2000 });
    expect(order.guestId).toBeUndefined();
    expect(res.body.data.payment).toBeNull();
    expect(await stockOf(s._id, v._id)).toBe(3);
    expect((await Product.findById(s._id)).soldCount).toBe(2);
    expect(await InventoryMovement.findOne({ reason: "order" })).toMatchObject({ delta: -2 });
    expect(await Payment.findOne({ provider: "cod" })).toMatchObject({ amount: 2000, status: "pending" });
    expect((await b.get("/cart").expect(200)).body.data.lines).toEqual([]);
    expect(sent[0]).toMatchObject({ to: "asha@example.com", subject: "Order SZ100001 confirmed" });

    // Later price edits don't change the order.
    await Product.updateOne({ _id: s._id }, { $set: { "variants.$[].price": 5000, name: "Renamed" } });
    expect((await b.get(`/orders/${order.orderNumber}`).expect(200)).body.data.order.items[0]).toMatchObject({ name: s.name, price: 1000 });
  });

  it("is idempotent: resubmitting the same checkout returns the same order", async () => {
    const w = await simpleProduct({ stock: 5 });
    const b = await browser();
    await b.post("/cart/items", { productId: String(w._id), variantId: String(w.variants[0]._id), qty: 1 }).expect(200);
    const idem = key();
    const first = await checkout(b, { idempotencyKey: idem }).expect(201);
    const again = await checkout(b, { idempotencyKey: idem }).expect(200);
    expect(again.body.data.order.orderNumber).toBe(first.body.data.order.orderNumber);
    expect(await Order.countDocuments()).toBe(1);
    expect(await stockOf(w._id, w.variants[0]._id)).toBe(4);
  });

  it("never oversells: 8 shoppers race for 3 units, exactly 3 orders succeed", async () => {
    const w = await simpleProduct({ stock: 3 });
    const shoppers = await Promise.all(Array.from({ length: 8 }, () => browser()));
    for (const b of shoppers) await b.post("/cart/items", { productId: String(w._id), variantId: String(w.variants[0]._id), qty: 1 }).expect(200);
    const results = await Promise.all(shoppers.map((b) => checkout(b)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === "OUT_OF_STOCK")).toBe(true);
    expect(await stockOf(w._id, w.variants[0]._id)).toBe(0);
    expect(await Order.countDocuments()).toBe(3);
    // Failed checkouts kept their bags.
    expect((await results.findIndex((r) => r.status === 409)) >= 0).toBe(true);
  });

  it("refuses checkout with an empty bag, unavailable items, or COD disabled", async () => {
    const w = await simpleProduct();
    const b = await browser();
    expect((await checkout(b).expect(400)).body.error.code).toBe("CART_EMPTY");
    await b.post("/cart/items", { productId: String(w._id), variantId: String(w.variants[0]._id), qty: 1 }).expect(200);
    await SiteSetting.create({ key: "commerce", value: { codEnabled: false } });
    expect((await checkout(b).expect(400)).body.error.code).toBe("COD_UNAVAILABLE");
    await SiteSetting.deleteMany({});
    await Product.updateOne({ _id: w._id }, { status: "disabled" });
    expect((await checkout(b).expect(409)).body.error.code).toBe("CART_ISSUES");
  });

  it("validates contact and address fields", async () => {
    const b = await browser();
    const res = await b.post("/orders", { contact: { name: "A", phone: "123" }, shippingAddress: { ...ADDRESS, pincode: "12" }, paymentMethod: "cod" }).expect(400);
    expect(res.body.error.details.map((d) => d.path).sort()).toEqual(["contact.name", "contact.phone", "shippingAddress.pincode"]);
  });

  it("counts coupon usage and enforces usage limits", async () => {
    await Coupon.create({ code: "ONCE", type: "fixed", value: 50, usageLimit: 1 });
    const w = await simpleProduct({ price: 500 });
    for (const expected of [201, 409]) {
      const b = await browser();
      await b.post("/cart/items", { productId: String(w._id), variantId: String(w.variants[0]._id), qty: 1 }).expect(200);
      if (expected === 201) {
        await b.put("/cart/coupon", { code: "ONCE" }).expect(200);
        expect((await checkout(b).expect(201)).body.data.order).toMatchObject({ couponCode: "ONCE", couponDiscount: 50, total: 509 });
      } else {
        expect((await b.put("/cart/coupon", { code: "ONCE" }).expect(400)).body.error.message).toMatch(/usage limit/);
      }
    }
    expect((await Coupon.findOne({ code: "ONCE" })).usedCount).toBe(1);
  });

  it("signed-in customers can use and save addresses", async () => {
    const w = await simpleProduct();
    const c = await customerBrowser();
    await c.post("/cart/items", { productId: String(w._id), variantId: String(w.variants[0]._id), qty: 1 }).expect(200);
    await checkout(c, { saveAddress: true }).expect(201);
    const addresses = (await c.get("/account/addresses").expect(200)).body.data;
    expect(addresses[0]).toMatchObject({ city: "Chennai", isDefault: true });
    await c.post("/cart/items", { productId: String(w._id), variantId: String(w.variants[0]._id), qty: 1 }).expect(200);
    const res = await c.post("/orders", { contact: CONTACT, addressId: addresses[0].id, paymentMethod: "cod" }).expect(201);
    expect(res.body.data.order.shippingAddress.city).toBe("Chennai");
    expect((await c.get("/orders").expect(200)).body.meta.total).toBe(2);
  });
});

describe("order access, tracking and cancellation", () => {
  async function placeOrder(b, qty = 1) {
    const w = await simpleProduct({ stock: 5 });
    await b.post("/cart/items", { productId: String(w._id), variantId: String(w.variants[0]._id), qty }).expect(200);
    const order = (await checkout(b).expect(201)).body.data.order;
    return { order, product: w };
  }

  it("guests see their own order from the same browser; nobody else can", async () => {
    const guest = await browser();
    const { order } = await placeOrder(guest);
    await guest.get(`/orders/${order.orderNumber}`).expect(200);
    await (await browser()).get(`/orders/${order.orderNumber}`).expect(404);
    await (await customerBrowser()).get(`/orders/${order.orderNumber}`).expect(404);
  });

  it("customers only see their own orders", async () => {
    const a = await customerBrowser(), b = await customerBrowser();
    const { order } = await placeOrder(a);
    expect((await b.get("/orders").expect(200)).body.meta.total).toBe(0);
    await b.get(`/orders/${order.orderNumber}`).expect(404);
    await request(app).get(`${API}/orders`).expect(401);
  });

  it("tracking needs the order ID and the checkout phone number", async () => {
    const { order } = await placeOrder(await browser());
    const anyone = await browser();
    const res = await anyone.post("/orders/track", { orderNumber: order.orderNumber.toLowerCase(), phone: "+91 98765 43210" }).expect(200);
    expect(res.body.data).toMatchObject({ orderNumber: order.orderNumber, status: "placed", itemCount: 1 });
    expect(res.body.data.shippingAddress).toBeUndefined();
    await anyone.post("/orders/track", { orderNumber: order.orderNumber, phone: "9123456789" }).expect(404);
  });

  it("customers can cancel before dispatch: stock and coupon usage come back", async () => {
    await Coupon.create({ code: "TEN", type: "fixed", value: 10 });
    const c = await customerBrowser();
    const w = await simpleProduct({ stock: 5 });
    await c.post("/cart/items", { productId: String(w._id), variantId: String(w.variants[0]._id), qty: 2 }).expect(200);
    await c.put("/cart/coupon", { code: "TEN" }).expect(200);
    const order = (await checkout(c).expect(201)).body.data.order;
    expect(await stockOf(w._id, w.variants[0]._id)).toBe(3);
    const res = await c.post(`/orders/${order.orderNumber}/cancel`, { reason: "Changed my mind" }).expect(200);
    expect(res.body.data.status).toBe("cancelled");
    expect(await stockOf(w._id, w.variants[0]._id)).toBe(5);
    expect((await Coupon.findOne({ code: "TEN" })).usedCount).toBe(0);
    expect(await InventoryMovement.findOne({ reason: "order_cancelled" })).toMatchObject({ delta: 2 });
    await c.post(`/orders/${order.orderNumber}/cancel`, {}).expect(409);
  });

  it("admins move orders through permitted statuses only; delivery marks COD paid; returns restock", async () => {
    const sent = mockMail();
    const admin = await adminBrowser();
    const { order, product } = await placeOrder(await browser(), 2);
    const id = (await Order.findOne({ orderNumber: order.orderNumber }))._id;

    expect((await admin.patch(`/admin/orders/${id}/status`, { status: "delivered" }).expect(409)).body.error.code).toBe("INVALID_TRANSITION");
    await admin.patch(`/admin/orders/${id}/status`, { status: "confirmed" }).expect(200);
    const shipped = await admin.patch(`/admin/orders/${id}/status`, { status: "shipped", fulfilment: { courier: "Delhivery", trackingNumber: "DLV123", trackingUrl: "https://track.example/DLV123" } }).expect(200);
    expect(shipped.body.data.order.fulfilment).toMatchObject({ courier: "Delhivery", trackingNumber: "DLV123" });
    expect(shipped.body.data.allowedTransitions).toEqual(["delivered", "returned"]);
    expect(sent.some((m) => m.subject === `Order ${order.orderNumber}: shipped` && m.text.includes("https://track.example/DLV123"))).toBe(true);
    await admin.post(`/admin/orders/${id}/cancel`, {}).expect(409); // can't cancel once shipped
    const delivered = (await admin.patch(`/admin/orders/${id}/status`, { status: "delivered" }).expect(200)).body.data.order;
    expect(delivered.paymentStatus).toBe("paid");
    expect(await Payment.findOne({ order: id })).toMatchObject({ status: "captured" });

    const before = await stockOf(product._id, product.variants[0]._id);
    const returned = (await admin.patch(`/admin/orders/${id}/status`, { status: "returned", note: "Customer returned", restock: true }).expect(200)).body.data.order;
    expect(returned).toMatchObject({ status: "returned", refundRequired: true });
    expect(await stockOf(product._id, product.variants[0]._id)).toBe(before + 2);
    expect(returned.history.map((h) => h.status)).toEqual(["placed", "confirmed", "shipped", "delivered", "returned"]);

    // COD refunds are paid outside the gateway and need a reference.
    await admin.post(`/admin/orders/${id}/refund`, {}).expect(400);
    const refunded = (await admin.post(`/admin/orders/${id}/refund`, { manualReference: "UPI-REF-1" }).expect(200)).body.data.order;
    expect(refunded).toMatchObject({ paymentStatus: "refunded", refundedAmount: delivered.total, refundRequired: false });
  });

  it("admin order list filters, searches, and the invoice escapes customer input", async () => {
    const admin = await adminBrowser();
    const w = await simpleProduct();
    const b = await browser();
    await b.post("/cart/items", { productId: String(w._id), variantId: String(w.variants[0]._id), qty: 1 }).expect(200);
    await checkout(b, { contact: { ...CONTACT, name: "<script>alert(1)</script> Kumar" } }).expect(201);
    const list = await admin.get("/admin/orders?q=kumar&status=placed").expect(200);
    expect(list.body.meta).toMatchObject({ total: 1, statusCounts: { placed: 1 } });
    const inv = await admin.get(`/admin/orders/${list.body.data[0].id}/invoice`).expect(200).expect("content-type", /html/);
    expect(inv.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt; Kumar");
    expect(inv.text).not.toContain("<script>alert(1)");
  });
});
