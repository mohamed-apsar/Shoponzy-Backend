import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { API, app, browser, useDb } from "./helpers.js";
import { ADDRESS, CONTACT, adminBrowser, customerBrowser, key, mockMail, simpleProduct } from "./fixtures.js";
import { NewsletterSubscriber, ContactMessage } from "../src/models/site.js";
import { Campaign, EmailLog } from "../src/models/notification.js";
import { Coupon } from "../src/models/commerce.js";
import { setMailTransport } from "../src/services/emailService.js";
import { BATCH_SIZE, unsubscribeToken } from "../src/services/campaignService.js";

useDb();
let admin;
beforeEach(async () => { admin = await adminBrowser(); setMailTransport(null); });

describe("FAQ Management", () => {
  it("admins create, edit, reorder, hide and delete FAQs; the storefront sees active ones in order", async () => {
    await admin.post("/admin/faqs/import-defaults", {}).expect(201);
    await admin.post("/admin/faqs/import-defaults", {}).expect(409); // only into an empty list
    const a = (await admin.post("/admin/faqs", { question: "How long does delivery take?", answer: "3–7 working days.", category: "Shipping" }).expect(201)).body.data;
    await admin.post("/admin/faqs", { question: "Hi", answer: "x" }).expect(400);
    let list = (await admin.get("/admin/faqs").expect(200)).body;
    expect(list.data).toHaveLength(4);
    expect(list.meta.categories).toEqual(["Orders", "Payments", "Products", "Shipping"]);

    await admin.put("/admin/faqs/order", { ids: [a.id] }).expect(200);
    await admin.patch(`/admin/faqs/${list.data[0].id}`, { status: "hidden", answer: "Updated" }).expect(200);
    const pub = (await (await browser()).get("/faqs").expect(200)).body.data;
    expect(pub[0]).toMatchObject({ question: "How long does delivery take?", category: "Shipping" });
    expect(pub).toHaveLength(3);
    expect(pub[0].status).toBeUndefined();

    await admin.del(`/admin/faqs/${a.id}`).expect(200);
    list = (await admin.get("/admin/faqs?status=hidden").expect(200)).body;
    expect(list.data).toHaveLength(1);
    expect(list.meta.counts).toEqual({ active: 2, hidden: 1 });
    const csv = (await admin.get("/admin/faqs/export.csv").expect(200)).text.split("\n");
    expect(csv[0]).toBe("position,category,question,answer,status,updated");
    expect(csv).toHaveLength(4);
  });
});

describe("Notifications", () => {
  async function subscribers(n) {
    await NewsletterSubscriber.insertMany(Array.from({ length: n }, (_, i) => ({ email: `fan${String(i).padStart(3, "0")}@example.com` })));
  }

  it("creates new-arrival, offer and sale notifications with validation", async () => {
    const p = await simpleProduct({ name: "Fresh Sneaker" });
    const arrival = (await admin.post("/admin/notifications", { type: "new_arrival", title: "Nov drop", subject: "Just landed", message: "Our newest picks are here.", products: [String(p._id)] }).expect(201)).body.data;
    expect(arrival).toMatchObject({ status: "draft", type: "new_arrival" });
    await admin.post("/admin/notifications", { type: "offer", title: "Bad coupon", subject: "10% off", message: "Save now", couponCode: "NOPE" }).expect(400);
    await Coupon.create({ code: "SAVE10", type: "percent", value: 10 });
    await admin.post("/admin/notifications", { type: "offer", title: "Coupon", subject: "10% off", message: "Save now", couponCode: "save10", offerText: "10% off everything" }).expect(201);
    await admin.post("/admin/notifications", { type: "sale", title: "Sale", subject: "Weekend sale", message: "Big savings", startsAt: "2026-11-10", endsAt: "2026-11-09" }).expect(400);
    await admin.post("/admin/notifications", { type: "sale", title: "Sale", subject: "Weekend sale", message: "Big savings", ctaUrl: "javascript:alert(1)" }).expect(400);

    const preview = (await admin.get(`/admin/notifications/${arrival.id}/preview`).expect(200)).body.data;
    expect(preview.html).toContain("Fresh Sneaker");
    expect(preview.html).toContain("/products/fresh-sneaker");
    expect((await admin.get("/admin/notifications?type=offer").expect(200)).body.meta.total).toBe(1);
  });

  it("won't send without email configured; test sends and batch-sends to subscribers with unsubscribe links", async () => {
    await subscribers(BATCH_SIZE + 5);
    const c = (await admin.post("/admin/notifications", { type: "sale", title: "Diwali", subject: "Diwali sale is live", headline: "Up to 50% off", message: "Shop the sale." }).expect(201)).body.data;
    expect((await admin.post(`/admin/notifications/${c.id}/send`, {}).expect(503)).body.error.code).toBe("EMAIL_NOT_CONFIGURED");

    const sent = mockMail();
    await admin.post(`/admin/notifications/${c.id}/test`, { email: "me@shoponzy.in" }).expect(200);
    expect(sent[0]).toMatchObject({ to: "me@shoponzy.in", subject: "[TEST] Diwali sale is live" });
    expect(sent[0].html).toContain("Up to 50% off");

    let r = (await admin.post(`/admin/notifications/${c.id}/send`, {}).expect(200)).body.data;
    expect(r).toMatchObject({ status: "sending", stats: { total: BATCH_SIZE + 5, sent: BATCH_SIZE, failed: 0 } });
    await admin.patch(`/admin/notifications/${c.id}`, { subject: "Changed" }).expect(409); // no edits once sending
    r = (await admin.post(`/admin/notifications/${c.id}/send`, {}).expect(200)).body.data;
    expect(r).toMatchObject({ status: "sent", stats: { sent: BATCH_SIZE + 5 } });
    expect(r.cursor).toBeUndefined();
    await admin.post(`/admin/notifications/${c.id}/send`, {}).expect(200); // idempotent once sent
    const campaignMails = sent.filter((m) => m.subject === "Diwali sale is live");
    expect(campaignMails).toHaveLength(BATCH_SIZE + 5);
    expect(new Set(campaignMails.map((m) => m.to)).size).toBe(BATCH_SIZE + 5); // nobody twice
    expect(campaignMails[0].headers["List-Unsubscribe"]).toMatch(/newsletter\/unsubscribe\?e=/);
    expect(await EmailLog.countDocuments({ type: "campaign", status: "sent" })).toBe(BATCH_SIZE + 5);
    await admin.del(`/admin/notifications/${c.id}`).expect(409); // sent ones are kept

    const summary = (await admin.get("/admin/notifications/summary").expect(200)).body.data;
    expect(summary).toMatchObject({ subscribers: BATCH_SIZE + 5, emailConfigured: true, campaigns: { sent: 1 } });
  });

  it("unsubscribe links are signed and stop future emails", async () => {
    await subscribers(2);
    const email = "fan000@example.com";
    await request(app).get(`${API}/newsletter/unsubscribe?e=${email}&t=${"0".repeat(32)}`).expect(400);
    const page = await request(app).get(`${API}/newsletter/unsubscribe?e=${email}&t=${unsubscribeToken(email)}`).expect(200);
    expect(page.text).toContain("<form method=\"post\"");
    await request(app).post(`${API}/newsletter/unsubscribe?e=${email}&t=${unsubscribeToken(email)}`).type("form").send("List-Unsubscribe=One-Click").expect(200);
    expect((await NewsletterSubscriber.findOne({ email })).status).toBe("unsubscribed");

    const sent = mockMail();
    const c = (await admin.post("/admin/notifications", { type: "offer", title: "Weekly offer", subject: "Offer", message: "Hello there" }).expect(201)).body.data;
    expect((await admin.post(`/admin/notifications/${c.id}/send`, {}).expect(200)).body.data.stats.total).toBe(1);
    expect(sent.map((m) => m.to)).toEqual(["fan001@example.com"]);
  });

  it("order and return email switches, and the email log", async () => {
    const sent = mockMail();
    await admin.put("/admin/notifications/settings", { orderConfirmation: false }).expect(200);
    const p = await simpleProduct({ stock: 5 });
    const b = await browser();
    await b.post("/cart/items", { productId: String(p._id), variantId: String(p.variants[0]._id), qty: 1 }).expect(200);
    const order = (await b.post("/orders", { contact: { ...CONTACT, email: "buyer@example.com" }, shippingAddress: ADDRESS, paymentMethod: "cod", idempotencyKey: key() }).expect(201)).body.data.order;
    await admin.patch(`/admin/orders/${order.id}/status`, { status: "shipped" }).expect(200);
    await new Promise((r) => setTimeout(r, 150)); // emails are fire-and-forget
    expect(sent.map((m) => m.subject)).toEqual([`Order ${order.orderNumber}: shipped`]); // confirmation switched off
    const logs = (await admin.get("/admin/notifications/email-log?type=order_status").expect(200)).body;
    expect(logs.data[0]).toMatchObject({ to: "buyer@example.com", status: "sent", ref: order.orderNumber });
    await admin.put("/admin/notifications/settings", { bogus: true }).expect(400);
    const settings = (await admin.get("/admin/notifications/settings").expect(200)).body.data;
    expect(settings).toMatchObject({ emailConfigured: true, settings: { orderConfirmation: false, orderShipped: true } });
    expect((await admin.get("/admin/notifications/email-log/export.csv").expect(200)).text.split("\n")[0]).toBe("date_time,to,subject,type,status,error,reference");
  });
});

describe("Help & Support", () => {
  it("contact messages: auto-acknowledgement, open, reply by email, notes, close, export", async () => {
    const sent = mockMail();
    const visitor = await browser();
    await visitor.post("/contact", { name: "Asha", phone: "9876543210", email: "asha@example.com", topic: "Order question", message: "Where is my parcel?" }).expect(201);
    await visitor.post("/contact", { name: "Ravi", phone: "9876543211", message: "Do you ship to Goa?" }).expect(201);
    await new Promise((r) => setTimeout(r, 150));
    expect(sent.map((m) => [m.to, m.subject])).toEqual([["asha@example.com", "We have received your message"]]);

    const list = (await admin.get("/admin/contact-messages?status=new").expect(200)).body;
    expect(list.meta.total).toBe(2);
    const asha = list.data.find((m) => m.name === "Asha");
    const ravi = list.data.find((m) => m.name === "Ravi");
    expect((await admin.get(`/admin/contact-messages/${asha.id}`).expect(200)).body.data.status).toBe("read"); // opened

    const replied = (await admin.post(`/admin/contact-messages/${asha.id}/reply`, { message: "It ships tomorrow." }).expect(200)).body.data;
    expect(replied).toMatchObject({ status: "replied" });
    expect(replied.replies[0]).toMatchObject({ message: "It ships tomorrow.", emailed: true, by: { name: "Store Admin" } });
    expect(sent.at(-1)).toMatchObject({ to: "asha@example.com", subject: "Re: Order question" });
    expect(sent.at(-1).text).toContain("Where is my parcel?");

    // No email address: emailing is refused; the reply can be recorded after a phone call.
    await admin.post(`/admin/contact-messages/${ravi.id}/reply`, { message: "Yes we do." }).expect(400);
    const noted = (await admin.post(`/admin/contact-messages/${ravi.id}/reply`, { message: "Called: yes, we ship to Goa.", sendEmail: false, close: true }).expect(200)).body.data;
    expect(noted).toMatchObject({ status: "closed" });
    expect(noted.replies[0].emailed).toBe(false);
    await admin.post(`/admin/contact-messages/${ravi.id}/notes`, { note: "Repeat customer" }).expect(200);
    await admin.patch(`/admin/contact-messages/${ravi.id}`, { status: "read" }).expect(200);
    expect((await admin.get("/admin/contact-messages").expect(200)).body.meta.counts).toEqual({ replied: 1, read: 1 });
    const csv = (await admin.get("/admin/contact-messages/export.csv").expect(200)).text.split("\n");
    expect(csv[0]).toBe("received,name,phone,email,topic,order_id,message,status,replies,last_reply");
    expect(csv).toHaveLength(3);
    expect(await ContactMessage.countDocuments()).toBe(2);
  });

  it("new admin areas are admin-only", async () => {
    const customer = await customerBrowser();
    for (const path of ["/admin/faqs", "/admin/notifications", "/admin/notifications/summary", "/admin/notifications/settings", "/admin/notifications/email-log", "/admin/contact-messages"]) {
      await customer.get(path).expect(401);
    }
    await customer.post("/admin/notifications", { type: "sale", title: "x", subject: "xyz", message: "hello" }).expect(401);
    expect(await Campaign.countDocuments()).toBe(0);
  });
});
