import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { API, app, browser, useDb } from "./helpers.js";
import { ADDRESS, CONTACT, adminBrowser, category, customerBrowser, key, mockCloudinary, simpleProduct, sneaker } from "./fixtures.js";
import { Order } from "../src/models/commerce.js";
import { Session } from "../src/models/Session.js";
import { AuditLog } from "../src/models/AuditLog.js";

useDb();
let admin;
beforeEach(async () => { admin = await adminBrowser(); });
const pub = (path) => request(app).get(API + path);

describe("Manage Site settings", () => {
  it("defaults match the live storefront; saved changes appear on the public endpoint", async () => {
    const before = (await pub("/site-settings").expect(200)).body.data;
    expect(before.branding.primaryColor).toBe("#FF4D2E");
    expect(before.commerce).toMatchObject({ freeShippingAbove: 999, shippingFee: 59, prepaidOffPct: 5, codEnabled: true });
    expect(before.announcement.active).toBe(true);

    await admin.patch("/admin/site-settings/announcement", { messages: ["Diwali sale is live"], enabled: true }).expect(200);
    await admin.patch("/admin/site-settings/contact", { whatsapp: "919812345678", instagram: "https://instagram.com/shoponzy" }).expect(200);
    await admin.patch("/admin/site-settings/maintenance", { enabled: true, heading: "Back soon" }).expect(200);
    const after = (await pub("/site-settings").expect(200)).body.data;
    expect(after.announcement.messages).toEqual(["Diwali sale is live"]);
    expect(after.contact).toMatchObject({ whatsapp: "919812345678", instagram: "https://instagram.com/shoponzy", email: "support@shoponzy.in" });
    expect(after.maintenance).toMatchObject({ enabled: true, heading: "Back soon" });
    expect(await AuditLog.countDocuments({ action: "settings.updated" })).toBe(3);
  });

  it("validates each section and resets to defaults", async () => {
    await admin.patch("/admin/site-settings/branding", { primaryColor: "red" }).expect(400);
    await admin.patch("/admin/site-settings/contact", { instagram: "javascript:alert(1)" }).expect(400);
    await admin.patch("/admin/site-settings/commerce", { prepaidOffPct: 80 }).expect(400);
    await admin.patch("/admin/site-settings/nope", {}).expect(404);
    await admin.patch("/admin/site-settings/announcement", { startDate: "2099-01-01" }).expect(200);
    expect((await pub("/site-settings").expect(200)).body.data.announcement.active).toBe(false); // scheduled for later
    // Clearing dates with null (as the admin form does) must store null, not 1970-01-01.
    const cleared = (await admin.patch("/admin/site-settings/announcement", { startDate: null, endDate: null }).expect(200)).body.data;
    expect([cleared.startDate, cleared.endDate]).toEqual([null, null]);
    expect((await pub("/site-settings").expect(200)).body.data.announcement.active).toBe(true);
    await admin.post("/admin/site-settings/announcement/reset", {}).expect(200);
    expect((await pub("/site-settings").expect(200)).body.data.announcement.active).toBe(true);
  });

  it("logo uploads attach to branding and the replaced logo is deleted", async () => {
    const { destroyed } = mockCloudinary();
    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d", "hex"), Buffer.alloc(64)]);
    const up = async () => (await admin.agent.post(`${API}/admin/uploads`).set("X-CSRF-Token", admin.token).field("kind", "logo").attach("file", png, "l.png").expect(201)).body.data;
    const a = await up(), b = await up();
    await admin.patch("/admin/site-settings/branding", { logo: a }).expect(200);
    expect((await pub("/site-settings").expect(200)).body.data.branding.logo.url).toBe(a.url);
    await admin.patch("/admin/site-settings/branding", { logo: b }).expect(200);
    expect(destroyed).toEqual([a.publicId]);
  });

  it("saves the New In circular image and releases it when removed", async () => {
    const { destroyed } = mockCloudinary();
    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d", "hex"), Buffer.alloc(64)]);
    const upload = async () => (await admin.agent.post(`${API}/admin/uploads`).set("X-CSRF-Token", admin.token)
      .field("kind", "category").attach("file", png, "new-in.png").expect(201)).body.data;
    const image = await upload();

    await admin.patch("/admin/site-settings/homeCategories", { newInImage: image }).expect(200);
    expect((await pub("/site-settings").expect(200)).body.data.homeCategories.newInImage.url).toBe(image.url);

    await admin.patch("/admin/site-settings/homeCategories", { newInImage: null }).expect(200);
    expect((await pub("/site-settings").expect(200)).body.data.homeCategories.newInImage).toBeNull();
    expect(destroyed).toEqual([image.publicId]);
  });
});

describe("banners, homepage sections, popups and pages", () => {
  it("only active, in-schedule banners are public", async () => {
    await admin.post("/admin/banners", { title: "Live", background: "linear-gradient(120deg,#FF4D2E,#FF8A3D 60%)", url: "/categories/shoes", order: 2 }).expect(201);
    await admin.post("/admin/banners", { title: "First", order: 1 }).expect(201);
    await admin.post("/admin/banners", { title: "Off", status: "inactive" }).expect(201);
    await admin.post("/admin/banners", { title: "Future", startsAt: "2099-01-01" }).expect(201);
    await admin.post("/admin/banners", { title: "Bad", url: "javascript:alert(1)" }).expect(400);
    await admin.post("/admin/banners", { title: "Bad", background: "url(https://evil)" }).expect(400);
    await admin.post("/admin/banners", { title: "Bad", startsAt: "2026-02-01", endsAt: "2026-01-01" }).expect(400);
    expect((await pub("/banners").expect(200)).body.data.map((b) => b.title)).toEqual(["First", "Live"]);
    expect((await admin.get("/admin/banners").expect(200)).body.meta.total).toBe(4);
  });

  it("homepage resolves sections into products and categories, in order", async () => {
    const shoes = await category("Shoes");
    await sneaker({ name: "New Shoe" });
    await simpleProduct({ name: "Deal Wallet", price: 500, mrp: 2000 }); // 75% off vs the sneaker's 50%
    const s1 = (await admin.post("/admin/homepage-sections", { title: "New arrivals", source: "new", count: 4 }).expect(201)).body.data;
    const s2 = (await admin.post("/admin/homepage-sections", { title: "Deals", source: "deals", layout: "grid" }).expect(201)).body.data;
    await admin.post("/admin/homepage-sections", { title: "Shoes", source: "category", category: String(shoes._id) }).expect(201);
    await admin.post("/admin/homepage-sections", { title: "Explore", type: "categories", source: "categories" }).expect(201);
    await admin.post("/admin/homepage-sections", { title: "Hidden", source: "new", active: false }).expect(201);
    await admin.post("/admin/homepage-sections", { title: "No cat", source: "category" }).expect(400);
    await admin.put("/admin/homepage-sections/order", { ids: [s2.id, s1.id] }).expect(200);

    const home = (await pub("/homepage").expect(200)).body.data;
    expect(home.sections.map((s) => s.title)).toEqual(["Deals", "New arrivals", "Shoes", "Explore"]);
    expect(home.sections[0].products.map((p) => p.name)).toEqual(["Deal Wallet", "New Shoe"]);
    expect(home.sections[1].products.map((p) => p.name)).toEqual(["New Shoe"]);
    expect(home.sections[2].products.map((p) => p.name)).toEqual(["New Shoe"]);
    expect(home.sections[3].categories.map((c) => c.name).sort()).toEqual(["Essentials", "Shoes"]);
  });

  it("pages are public only when published; slugs are unique", async () => {
    const page = (await admin.post("/admin/pages", { title: "Shipping policy", slug: "shipping-policy", content: "Ships in 2 days.", status: "published" }).expect(201)).body.data;
    await admin.patch(`/admin/pages/${page.id}`, { seo: { title: "Shipping | Shoponzy", description: "Shipping details.", robots: "noindex, follow" } }).expect(200);
    await admin.post("/admin/pages", { title: "Draft", slug: "draft" }).expect(201);
    await admin.post("/admin/pages", { title: "Dup", slug: "shipping-policy" }).expect(409);
    expect((await pub("/pages/shipping-policy").expect(200)).body.data).toMatchObject({
      content: "Ships in 2 days.", seo: { title: "Shipping | Shoponzy", robots: "noindex, follow" },
    });
    await pub("/pages/draft").expect(404);
    expect((await pub("/pages").expect(200)).body.data.map((p) => p.slug)).toEqual(["shipping-policy"]);
  });

  it("popups respect status and schedule", async () => {
    await admin.post("/admin/popups", { title: "Welcome", trigger: "delay", delaySeconds: 5, frequency: "session" }).expect(201);
    await admin.post("/admin/popups", { title: "Expired", endsAt: "2020-01-01" }).expect(201);
    expect((await pub("/popups").expect(200)).body.data.map((p) => p.title)).toEqual(["Welcome"]);
  });

  it("coupons: unique codes and sensible values", async () => {
    await admin.post("/admin/coupons", { code: "save50", type: "fixed", value: 50 }).expect(201);
    await admin.post("/admin/coupons", { code: "SAVE50", type: "fixed", value: 60 }).expect(409);
    await admin.post("/admin/coupons", { code: "HUGE", type: "percent", value: 95 }).expect(400);
    expect((await admin.get("/admin/coupons?q=save").expect(200)).body.data[0].code).toBe("SAVE50");
  });
});

describe("contact, newsletter, SEO", () => {
  it("stores contact messages and subscribers for the admin", async () => {
    const b = await browser();
    await b.post("/contact", { name: "Ravi", phone: "9876543210", topic: "Order question", orderNumber: "sz100001", message: "Where is my order?" }).expect(201);
    await b.post("/contact", { name: "R", phone: "1", message: "x" }).expect(400);
    await b.post("/newsletter", { email: "Fan@Example.com" }).expect(200);
    await b.post("/newsletter", { email: "fan@example.com" }).expect(200);
    const msgs = (await admin.get("/admin/contact-messages").expect(200)).body.data;
    expect(msgs[0]).toMatchObject({ name: "Ravi", orderNumber: "SZ100001", status: "new" });
    await admin.patch(`/admin/contact-messages/${msgs[0].id}`, { status: "closed" }).expect(200);
    expect((await admin.get("/admin/newsletter").expect(200)).body.meta.total).toBe(1);
    expect((await admin.get("/admin/newsletter/export.csv").expect(200)).text).toContain("fan@example.com");
  });

  it("sitemap lists categories and products on the storefront domain; robots points at it", async () => {
    const s = await sneaker();
    const xml = (await pub("/seo/sitemap.xml").expect(200).expect("content-type", /xml/)).text;
    expect(xml).toContain("<loc>http://localhost:5173/categories/shoes</loc>");
    expect(xml).toContain(`<loc>http://localhost:5173/products/${s.slug}</loc>`);
    expect((await pub("/seo/robots.txt").expect(200)).text).toContain("Sitemap: http://localhost:5173/sitemap.xml");
  });

  it("saves webmaster, robots and uploaded sitemap settings and serves them publicly", async () => {
    const sitemapXml = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://shoponzy.in/custom</loc></url></urlset>';
    await admin.patch("/admin/site-settings/seo", {
      googleVerification: "google-id", robotsTxt: "User-agent: *\nDisallow: /private\n", robotsMeta: "noindex, follow", sitemapXml,
    }).expect(200);
    const settings = (await pub("/site-settings").expect(200)).body.data.seo;
    expect(settings).toMatchObject({ googleVerification: "google-id", robotsMeta: "noindex, follow" });
    const extendedRobots = "index, nofollow, noarchive, noimageindex, nosnippet, max-snippet:120, max-video-preview:0, max-image-preview:large";
    await admin.patch("/admin/site-settings/seo", { robotsMeta: extendedRobots }).expect(200);
    expect((await pub("/site-settings").expect(200)).body.data.seo.robotsMeta).toBe(extendedRobots);
    await admin.patch("/admin/site-settings/seo", { robotsMeta: "index, follow, invalid-directive" }).expect(400);
    expect(settings.sitemapXml).toBeUndefined();
    expect((await pub("/seo/robots.txt").expect(200)).text).toBe("User-agent: *\nDisallow: /private\n");
    expect((await pub("/seo/sitemap.xml").expect(200)).text).toBe(sitemapXml);
    const uploaded = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://shoponzy.in/uploaded</loc></url></urlset>';
    await admin.agent.post(`${API}/admin/seo/sitemap/upload`).set("X-CSRF-Token", admin.token)
      .attach("file", Buffer.from(uploaded), { filename: "sitemap.xml", contentType: "application/xml" }).expect(200);
    expect((await pub("/seo/sitemap.xml").expect(200)).text).toBe(uploaded);
    await admin.agent.post(`${API}/admin/seo/sitemap/upload`).set("X-CSRF-Token", admin.token)
      .attach("file", Buffer.from("<!DOCTYPE urlset><urlset/>"), { filename: "bad.xml", contentType: "application/xml" }).expect(400);
    await admin.patch("/admin/site-settings/seo", { sitemapXml: "<!DOCTYPE urlset><urlset/>" }).expect(400);
  });

  it("tracks storefront 404s and lets admins manage redirects", async () => {
    const storefront = await browser();
    await storefront.post("/seo/404", { path: "/missing-page" }).expect(200);
    await storefront.post("/seo/404", { path: "/missing-page" }).expect(200);
    await storefront.post("/seo/404", { path: "//external.example" }).expect(400);

    const logs = (await admin.get("/admin/seo/404-logs").expect(200)).body;
    expect(logs.meta.total).toBe(1);
    expect(logs.data[0]).toMatchObject({ path: "/missing-page", hits: 2, redirectTo: "" });
    const id = logs.data[0].id;
    await admin.patch(`/admin/seo/404-logs/${id}`, { redirectTo: "/products" }).expect(200);
    expect((await storefront.post("/seo/404", { path: "/missing-page" }).expect(200)).body.data.redirectTo).toBe("/products");
    await admin.patch(`/admin/seo/404-logs/${id}`, { redirectTo: "javascript:alert(1)" }).expect(400);
    await admin.del(`/admin/seo/404-logs/${id}`).expect(200);
    expect((await admin.get("/admin/seo/404-logs").expect(200)).body.meta.total).toBe(0);
  });

  it("generates and publishes a fresh sitemap from the current catalog", async () => {
    const product = await sneaker();
    const result = await admin.post("/admin/seo/sitemap/generate", {}).expect(200);
    expect(result.body.data.sitemapXml).toContain(`<loc>http://localhost:5173/products/${product.slug}</loc>`);
    expect((await pub("/seo/sitemap.xml").expect(200)).text).toBe(result.body.data.sitemapXml);
  });
});

describe("dashboard and customers", () => {
  it("computes sales, orders, stock alerts, trend and best sellers from real orders", async () => {
    const w = await simpleProduct({ name: "Wallet", price: 600, stock: 10 });
    const low = await simpleProduct({ name: "Belt", price: 400, stock: 3 });
    await simpleProduct({ name: "Gone", stock: 0 });
    const shop = async (product, qty) => {
      const b = await browser();
      await b.post("/cart/items", { productId: String(product._id), variantId: String(product.variants[0]._id), qty }).expect(200);
      return (await b.post("/orders", { contact: CONTACT, shippingAddress: ADDRESS, paymentMethod: "cod", idempotencyKey: key() }).expect(201)).body.data.order;
    };
    await shop(w, 2);           // 1200
    await shop(low, 1);         // 400 + 59 shipping = 459
    const cancelled = await shop(w, 1);
    await Order.updateOne({ orderNumber: cancelled.orderNumber }, { status: "cancelled" });
    // An old order outside the 7-day window
    await Order.create({ orderNumber: "SZ900000", contact: { name: "Old", phone: "9876543210" }, items: [], total: 999, paymentMethod: "cod", status: "delivered", createdAt: new Date(Date.now() - 20 * 86_400_000) });
    await customerBrowser();

    const d = (await admin.get("/admin/dashboard?days=7").expect(200)).body.data;
    expect(d.totals.sales.value).toBe(1659);
    expect(d.totals.orders.value).toBe(2);
    expect(d.totals.averageOrderValue).toBe(829.5);
    expect(d.totals.customers.value).toBe(1);
    expect(d.totals.products).toBe(3);
    expect(d.pendingOrders).toBe(2);
    expect(d.inventory.outOfStock).toBe(1);
    expect(d.inventory.lowStock.map((p) => [p.name, p.variants[0].stock])).toEqual([["Belt", 2]]);
    expect(d.salesTrend).toHaveLength(7);
    expect(d.salesTrend.at(-1)).toMatchObject({ revenue: 1659, orders: 2 });
    expect(d.bestSellers[0]).toMatchObject({ name: "Wallet", qty: 2, revenue: 1200 });
    expect(d.recentOrders).toHaveLength(4);
    expect((await admin.get("/admin/dashboard?days=30").expect(200)).body.data.totals.sales.value).toBe(1659 + 999);
  });

  it("customer detail shows orders and spend; disabling signs them out; admins can't be disabled here", async () => {
    const c = await customerBrowser();
    await Order.create({ orderNumber: "SZ100050", user: c.user._id, contact: { name: "C", phone: "9876543210" }, items: [], total: 750, paymentMethod: "cod", status: "delivered" });
    const detail = (await admin.get(`/admin/users/${c.user._id}`).expect(200)).body.data;
    expect(detail.stats).toMatchObject({ totalSpent: 750, orders: 1 });
    expect(detail.user.passwordHash).toBeUndefined();
    await admin.patch(`/admin/users/${c.user._id}/status`, { status: "disabled" }).expect(200);
    await c.get("/auth/me").expect(401);
    expect(await Session.countDocuments({ user: c.user._id, revokedAt: null })).toBe(0);
    await admin.patch(`/admin/users/${admin.user._id}/status`, { status: "disabled" }).expect(400);
  });

  it("wishlist stats rank the most-saved products", async () => {
    const a = await simpleProduct({ name: "Popular" }), b = await simpleProduct({ name: "Niche" });
    for (const ids of [[a], [a, b]]) {
      const c = await customerBrowser();
      for (const p of ids) await c.post("/account/wishlist", { productId: String(p._id) }).expect(200);
    }
    expect((await admin.get("/admin/wishlists").expect(200)).body.data.map((r) => [r.name, r.count])).toEqual([["Popular", 2], ["Niche", 1]]);
  });

  it("every admin endpoint refuses customers", async () => {
    const c = await customerBrowser();
    for (const path of ["/admin/dashboard", "/admin/orders", "/admin/products", "/admin/categories", "/admin/transactions", "/admin/coupons", "/admin/site-settings", "/admin/banners", "/admin/audit-logs", "/admin/wishlists"]) {
      await c.get(path).expect(401);
    }
    await c.post("/admin/products", { name: "Hack", category: "0".repeat(24), price: 1 }).expect(401);
    await c.patch("/admin/site-settings/maintenance", { enabled: true }).expect(401);
  });
});
