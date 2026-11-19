import { describe, expect, it } from "vitest";
import { browser, useDb } from "./helpers.js";
import { ADDRESS, CONTACT, adminBrowser, customerBrowser, key, mockRazorpay, simpleProduct } from "./fixtures.js";
import { Product } from "../src/models/Product.js";
import { SiteSetting } from "../src/models/site.js";

useDb();
const item = (product, qty = 1) => ({ productId: String(product._id), variantId: String(product.variants[0]._id), qty });
const submit = (b, items, extra = {}) => b.post("/orders", { contact: CONTACT, shippingAddress: ADDRESS, paymentMethod: "cod", items, checkoutMode: "cart", idempotencyKey: key(), ...extra });

describe("checkout item selection", () => {
  it.each([500, 1500])("charges the configured PIN rate for a ₹%i selection and rejects unsupported PIN codes", async (price) => {
    await SiteSetting.create({ key: "shipping", value: {
      states: [{ name: "Tamil Nadu", enabled: true, districts: [{ name: "Chennai", enabled: true }] }],
      pincodes: [{ code: "625007", state: "Tamil Nadu", district: "Chennai", enabled: true, price: 40 }],
    } });
    const b = await browser();
    const product = await simpleProduct({ price });
    expect((await b.get("/site-settings").expect(200)).body.data.shipping.pincodes[0].price).toBe(40);
    await submit(b, [item(product)], { checkoutMode: "buy-now", shippingAddress: { ...ADDRESS, pincode: "600043" } }).expect(400);
    const order = (await submit(b, [item(product)], { checkoutMode: "buy-now", shippingAddress: { ...ADDRESS, pincode: "625007" } }).expect(201)).body.data.order;
    expect(order.shippingFee).toBe(40);
    expect(order.total).toBe(price + 40);
  });

  it.each(["guest", "account"])("Buy Now orders one product without changing the %s bag, including the same variant", async (kind) => {
    const b = await (kind === "account" ? customerBrowser() : browser());
    const a = await simpleProduct({ name: "Bag item", price: 700, stock: 5 });
    const direct = await simpleProduct({ name: "Buy now item", price: 500, stock: 5 });
    await b.post("/cart/items", item(a, 2)).expect(200);
    await b.post("/cart/items", item(direct, 3)).expect(200);
    const orderKey = key();
    const result = (await submit(b, [item(direct)], { checkoutMode: "buy-now", idempotencyKey: orderKey }).expect(201)).body.data.order;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ name: direct.name, qty: 1, price: 500 });
    expect(result.subtotal).toBe(500);
    expect(result.accountDiscount).toBe(kind === "account" ? 50 : 0);
    const cart = (await b.get("/cart").expect(200)).body.data;
    expect(cart.lines.map((line) => [line.name, line.qty])).toEqual([[a.name, 2], [direct.name, 3]]);
    await submit(b, [item(direct)], { checkoutMode: "buy-now", idempotencyKey: orderKey }).expect(200);
    expect((await Product.findById(direct._id)).variants[0].stock).toBe(4);
  });

  it("orders only selected bag quantities and keeps unselected items", async () => {
    const b = await browser();
    const a = await simpleProduct({ name: "Selected", price: 500 });
    const other = await simpleProduct({ name: "Keep in bag", price: 700 });
    await b.post("/cart/items", item(a, 3)).expect(200);
    await b.post("/cart/items", item(other)).expect(200);
    const order = (await submit(b, [item(a, 2)]).expect(201)).body.data.order;
    expect(order.items).toHaveLength(1);
    expect(order.subtotal).toBe(1000);
    expect((await b.get("/cart").expect(200)).body.data.lines.map((line) => [line.name, line.qty])).toEqual([[a.name, 1], [other.name, 1]]);
  });

  it("applies an admin-configured fixed account discount and places zero-total orders without payment", async () => {
    const admin = await adminBrowser();
    const customer = await customerBrowser();
    const guest = await browser();
    const product = await simpleProduct({ price: 1000, stock: 3 });
    await admin.patch("/admin/site-settings/commerce", { accountDiscount: { type: "percent", value: 91 } }).expect(400);
    const accountDiscount = { type: "fixed", value: 1200 };
    await admin.patch("/admin/site-settings/commerce", { accountDiscount }).expect(200);
    expect((await guest.get("/site-settings").expect(200)).body.data.commerce.accountDiscount).toEqual(accountDiscount);
    const guestOrder = (await submit(guest, [item(product)]).expect(201)).body.data.order;
    expect(guestOrder.accountDiscount).toBe(0);
    const online = (await submit(customer, [item(product)], { paymentMethod: "razorpay" }).expect(201)).body.data;
    expect(online.order).toMatchObject({ accountDiscount: 1000, total: 0, status: "placed", paymentStatus: "paid" });
    expect(online.payment).toBeNull();
    await admin.patch("/admin/site-settings/commerce", { accountDiscount: { type: "fixed", value: 0 } }).expect(200);
    const disabled = (await submit(customer, [item(product)]).expect(201)).body.data.order;
    expect(disabled.accountDiscount).toBe(0);
  });

  it("supports Buy Now with an empty bag and rejects empty or duplicate selections", async () => {
    const b = await browser();
    const product = await simpleProduct();
    await submit(b, [], { checkoutMode: "buy-now" }).expect(400);
    await submit(b, [item(product), item(product)]).expect(400);
    await submit(b, [item(product)], { checkoutMode: "buy-now" }).expect(201);
    expect((await b.get("/cart").expect(200)).body.data.lines).toEqual([]);
  });

  it("preserves the bag when the selected option is out of stock", async () => {
    const b = await browser();
    const keep = await simpleProduct();
    const sold = await simpleProduct({ stock: 0 });
    await b.post("/cart/items", item(keep)).expect(200);
    await submit(b, [item(sold)], { checkoutMode: "buy-now" }).expect(409);
    expect((await b.get("/cart").expect(200)).body.data.lines[0].productId).toBe(String(keep._id));
  });

  it("restores selected items after gateway failure without losing unselected items", async () => {
    const { client } = mockRazorpay();
    client.failCreate = true;
    const b = await browser();
    const selected = await simpleProduct({ name: "Selected" });
    const other = await simpleProduct({ name: "Unselected" });
    await b.post("/cart/items", item(selected, 2)).expect(200);
    await b.post("/cart/items", item(other)).expect(200);
    await submit(b, [item(selected)], { paymentMethod: "razorpay" }).expect(502);
    const lines = (await b.get("/cart").expect(200)).body.data.lines;
    expect(lines.map((line) => [line.name, line.qty])).toEqual([[selected.name, 2], [other.name, 1]]);
  });
});
