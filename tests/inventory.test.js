import { describe, expect, it, beforeEach } from "vitest";
import { browser, useDb } from "./helpers.js";
import { ADDRESS, CONTACT, adminBrowser, customerBrowser, key, simpleProduct, sneaker } from "./fixtures.js";
import { Product } from "../src/models/Product.js";
import { InventoryMovement } from "../src/models/commerce.js";
import { SiteSetting } from "../src/models/site.js";

useDb();
let admin;
beforeEach(async () => { admin = await adminBrowser(); });

const stockOf = async (p, v) => (await Product.findById(p._id)).variants.id(v._id).stock;

describe("inventory management", () => {
  it("summarises products, stock, low/out of stock and reserved units", async () => {
    await sneaker({ name: "Runner", stock: 10 }); // 6 variants × 10
    await simpleProduct({ name: "Empty", stock: 0 });
    const low = await simpleProduct({ name: "Nearly Gone", stock: 3 });
    // A COD order holds 2 units until it ships.
    const b = await browser();
    await b.post("/cart/items", { productId: String(low._id), variantId: String(low.variants[0]._id), qty: 2 }).expect(200);
    await b.post("/orders", { contact: CONTACT, shippingAddress: ADDRESS, paymentMethod: "cod", idempotencyKey: key() }).expect(201);

    const s = (await admin.get("/admin/inventory/summary").expect(200)).body.data;
    expect(s).toMatchObject({ totalProducts: 3, totalStock: 61, lowStockProducts: 1, outOfStockProducts: 1, reservedUnits: 2, lowStockThreshold: 5 });
  });

  it("lists one row per variant with search, category/status filters, sorting and pagination", async () => {
    const s = await sneaker({ name: "Trail Shoe", stock: 4 });
    await simpleProduct({ name: "Plenty", stock: 50, categoryName: "Bags" });
    await simpleProduct({ name: "None Left", stock: 0, categoryName: "Bags" });

    const all = (await admin.get("/admin/inventory?limit=5").expect(200)).body;
    expect(all.meta).toMatchObject({ total: 8, pages: 2, lowStockThreshold: 5 });
    expect(all.data[0]).toMatchObject({ name: "None Left", stock: 0, stockStatus: "out", reserved: 0 }); // stock_low first
    expect(all.data[0].lastUpdated).toBeTruthy();

    const lowRows = (await admin.get("/admin/inventory?stockStatus=low").expect(200)).body.data;
    expect(lowRows).toHaveLength(6);
    expect(lowRows.every((r) => r.name === "Trail Shoe" && r.threshold === 5)).toBe(true);
    expect((await admin.get("/admin/inventory?stockStatus=out").expect(200)).body.data.map((r) => r.name)).toEqual(["None Left"]);
    expect((await admin.get(`/admin/inventory?category=${s.category}&q=trail`).expect(200)).body.meta.total).toBe(6);
    const high = (await admin.get("/admin/inventory?sort=stock_high&limit=1").expect(200)).body.data[0];
    expect(high).toMatchObject({ name: "Plenty", stock: 50, stockStatus: "in", category: { name: "Bags" } });
    await admin.get("/admin/inventory?stockStatus=bogus").expect(400);
  });

  it("uses the configurable store threshold and per-product overrides", async () => {
    const p = await simpleProduct({ name: "Eight Left", stock: 8 });
    expect((await admin.get("/admin/inventory?stockStatus=low").expect(200)).body.meta.total).toBe(0);
    await admin.put("/admin/inventory/settings", { lowStockThreshold: 10 }).expect(200);
    expect((await admin.get("/admin/inventory/settings").expect(200)).body.data.lowStockThreshold).toBe(10);
    expect((await admin.get("/admin/inventory?stockStatus=low").expect(200)).body.meta.total).toBe(1);
    // The dashboard and product list agree with Inventory.
    expect((await admin.get("/admin/dashboard").expect(200)).body.data.inventory.lowStock).toHaveLength(1);
    expect((await admin.get("/admin/products?stock=low").expect(200)).body.meta.total).toBe(1);

    await admin.patch(`/admin/products/${p._id}/low-stock-threshold`, { lowStockThreshold: 2 }).expect(200);
    expect((await admin.get("/admin/inventory?stockStatus=low").expect(200)).body.meta.total).toBe(0);
    await admin.patch(`/admin/products/${p._id}/low-stock-threshold`, { lowStockThreshold: null }).expect(200);
    expect((await Product.findById(p._id)).lowStockThreshold).toBeNull();
    // The threshold is admin-only: the storefront settings don't include it.
    expect((await (await browser()).get("/site-settings").expect(200)).body.data.inventory).toBeUndefined();
    await admin.put("/admin/inventory/settings", { lowStockThreshold: -1 }).expect(400);
  });

  it("adds, removes and sets stock with a mandatory reason, recording who did it and before/after", async () => {
    const p = await simpleProduct({ stock: 5 });
    const v = p.variants[0];
    const url = `/admin/products/${p._id}/stock`;
    await admin.post(url, { variantId: String(v._id), delta: 3, reason: "restock", note: "Supplier delivery" }).expect(200);
    await admin.post(url, { variantId: String(v._id), delta: -2, reason: "damaged", note: "Water damage" }).expect(200);
    await admin.post(url, { variantId: String(v._id), set: 20, reason: "correction", note: "Stock count" }).expect(200);
    expect(await stockOf(p, v)).toBe(20);

    await admin.post(url, { variantId: String(v._id), delta: -21, note: "Too many" }).expect(409); // never negative
    await admin.post(url, { variantId: String(v._id), set: -1, note: "Bad" }).expect(400);
    await admin.post(url, { variantId: String(v._id), set: 20, note: "Same value" }).expect(400);
    await admin.post(url, { variantId: String(v._id), delta: 1, note: "" }).expect(400);
    // The form refuses to save if stock moved since it was opened.
    expect((await admin.post(url, { variantId: String(v._id), set: 25, note: "Recount", expectedStock: 19 }).expect(409)).body.error.message).toMatch(/changed to 20/);

    const moves = await InventoryMovement.find({ product: p._id, reason: { $ne: "initial" } }).sort({ createdAt: 1 }).lean();
    expect(moves.map(({ mode, before, delta, after, reason }) => ({ mode, before, delta, after, reason }))).toEqual([
      { mode: "add", before: 5, delta: 3, after: 8, reason: "restock" },
      { mode: "remove", before: 8, delta: -2, after: 6, reason: "damaged" },
      { mode: "set", before: 6, delta: 14, after: 20, reason: "correction" },
    ]);
    expect(moves.every((m) => String(m.actor) === String(admin.user._id))).toBe(true);
  });

  it("serves the adjustment history with search, filters and a CSV export", async () => {
    const p = await simpleProduct({ name: "Canvas Tote", stock: 5, sku: "TOTE-1" });
    await admin.post(`/admin/products/${p._id}/stock`, { variantId: String(p.variants[0]._id), delta: 4, reason: "restock", note: "=HYPERLINK(evil)" }).expect(200);
    await simpleProduct({ name: "Other", stock: 1 });

    const hist = (await admin.get("/admin/inventory/movements?q=tote").expect(200)).body;
    expect(hist.meta.total).toBe(2); // initial + restock
    expect(hist.data[0]).toMatchObject({ product: { name: "Canvas Tote" }, sku: "TOTE-1", before: 5, delta: 4, after: 9, mode: "add", reason: "restock", actor: { name: "Store Admin" } });
    expect((await admin.get("/admin/inventory/movements?manual=1").expect(200)).body.meta.total).toBe(1);
    expect((await admin.get("/admin/inventory/movements?reason=initial").expect(200)).body.meta.total).toBe(2);
    expect((await admin.get("/admin/inventory/movements?from=2000-01-01&to=2000-01-02").expect(200)).body.meta.total).toBe(0);

    const csv = await admin.get("/admin/inventory/movements/export.csv?q=tote").expect(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    const lines = csv.text.split("\n");
    expect(lines[0]).toBe("date_time,product,variant,sku,previous_qty,adjustment,new_qty,type,reason,note,updated_by,order,return");
    expect(lines).toHaveLength(3);
    expect(csv.text).toContain("'=HYPERLINK(evil)"); // formula-injection safe
  });

  it("order movements record before/after quantities too", async () => {
    const p = await simpleProduct({ stock: 4 });
    const b = await browser();
    await b.post("/cart/items", { productId: String(p._id), variantId: String(p.variants[0]._id), qty: 3 }).expect(200);
    await b.post("/orders", { contact: CONTACT, shippingAddress: ADDRESS, paymentMethod: "cod", idempotencyKey: key() }).expect(201);
    expect(await InventoryMovement.findOne({ reason: "order" }).lean()).toMatchObject({ before: 4, delta: -3, after: 1 });
  });

  it("is admin-only", async () => {
    const customer = await customerBrowser();
    for (const path of ["/admin/inventory", "/admin/inventory/summary", "/admin/inventory/movements", "/admin/inventory/movements/export.csv", "/admin/inventory/settings"]) {
      await (await browser()).get(path).expect(401);
      await customer.get(path).expect(401);
    }
    await (await browser()).put("/admin/inventory/settings", { lowStockThreshold: 1 }).expect(401);
    expect(await SiteSetting.exists({ key: "inventory" })).toBeNull();
  });
});
