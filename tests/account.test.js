import { describe, expect, it, afterEach } from "vitest";
import { PASSWORD, browser, createUser, useDb } from "./helpers.js";
import { ADDRESS, customerBrowser, disableMail, mockMail, simpleProduct, sneaker } from "./fixtures.js";
import { User } from "../src/models/User.js";
import { Session } from "../src/models/Session.js";
import { Order } from "../src/models/commerce.js";

useDb();
afterEach(disableMail);

describe("profile and password", () => {
  it("updates name and phone", async () => {
    const c = await customerBrowser();
    const res = await c.patch("/account/profile", { name: "New Name", phone: "09876543210" }).expect(200);
    expect(res.body.data.user).toMatchObject({ name: "New Name", phone: "9876543210" });
    await c.patch("/account/profile", { email: "x@example.com" }).expect(400); // email isn't editable here
  });

  it("changing the password needs the current one and signs out other devices", async () => {
    const user = await createUser({ email: "pw@example.com" });
    const phone = await browser(), laptop = await browser();
    await phone.post("/auth/login", { email: user.email, password: PASSWORD }).expect(200);
    await laptop.post("/auth/login", { email: user.email, password: PASSWORD }).expect(200);
    await laptop.post("/account/password", { currentPassword: "wrong", newPassword: "brand-new-pass" }).expect(400);
    await laptop.post("/account/password", { currentPassword: PASSWORD, newPassword: "brand-new-pass" }).expect(200);
    await laptop.get("/auth/me").expect(200);
    await phone.get("/auth/me").expect(401);
    await (await browser()).post("/auth/login", { email: user.email, password: "brand-new-pass" }).expect(200);
  });
});

describe("addresses", () => {
  it("first address becomes default; one default at a time; deleting the default promotes another", async () => {
    const c = await customerBrowser();
    let list = (await c.post("/account/addresses", ADDRESS).expect(200)).body.data;
    expect(list[0].isDefault).toBe(true);
    list = (await c.post("/account/addresses", { ...ADDRESS, label: "Work", city: "Coimbatore", isDefault: true }).expect(200)).body.data;
    expect(list.map((a) => a.isDefault)).toEqual([false, true]);
    list = (await c.patch(`/account/addresses/${list[0].id}`, { line2: "Near park" }).expect(200)).body.data;
    expect(list[0].line2).toBe("Near park");
    list = (await c.del(`/account/addresses/${list[1].id}`).expect(200)).body.data;
    expect(list).toHaveLength(1);
    expect(list[0].isDefault).toBe(true);
    await c.post("/account/addresses", { ...ADDRESS, pincode: "1234" }).expect(400);
  });
});

describe("wishlist", () => {
  it("adds, merges the guest wishlist, hides unavailable items and removes", async () => {
    const a = await sneaker({ name: "A" }), b = await simpleProduct({ name: "B" }), hidden = await simpleProduct({ name: "Hidden", status: "disabled" });
    const c = await customerBrowser();
    await c.post("/account/wishlist", { productId: String(a._id) }).expect(200);
    await c.post("/account/wishlist", { productId: String(hidden._id) }).expect(404);
    const merged = (await c.post("/account/wishlist/merge", { productIds: [String(a._id), String(b._id), String(hidden._id)] }).expect(200)).body.data;
    expect(merged.map((p) => p.name)).toEqual(["A", "B"]);
    expect((await c.del(`/account/wishlist/${a._id}`).expect(200)).body.data.map((p) => p.name)).toEqual(["B"]);
    await (await browser()).get("/account/wishlist").expect(401);
  });
});

describe("account deletion", () => {
  it("removes personal data and signs out, but keeps orders", async () => {
    const c = await customerBrowser({ email: "bye@example.com", phone: "9876543210" });
    await c.post("/account/addresses", ADDRESS).expect(200);
    await Order.create({ orderNumber: "SZ100009", user: c.user._id, contact: { name: "Bye", phone: "9876543210" }, items: [], total: 10, paymentMethod: "cod", status: "delivered" });
    await c.post("/account/delete", { password: "wrong" }).expect(400);
    await c.post("/account/delete", { password: PASSWORD }).expect(200);
    const u = await User.findById(c.user._id);
    expect(u).toMatchObject({ name: "Deleted user", status: "disabled", addresses: [] });
    expect(u.email).not.toContain("bye@");
    expect(u.phone).toBeUndefined();
    await c.get("/auth/me").expect(401);
    expect(await Order.countDocuments({ user: c.user._id })).toBe(1);
    await (await browser()).post("/auth/login", { email: "bye@example.com", password: PASSWORD }).expect(401);
  });
});

describe("password reset", () => {
  it("is honest when email isn't configured", async () => {
    const res = await (await browser()).post("/auth/forgot-password", { email: "a@example.com" }).expect(503);
    expect(res.body.error.code).toBe("EMAIL_NOT_CONFIGURED");
  });

  it("emails a single-use link, sets the new password and signs out everywhere", async () => {
    const sent = mockMail();
    const user = await createUser({ email: "reset@example.com" });
    const old = await browser();
    await old.post("/auth/login", { email: user.email, password: PASSWORD }).expect(200);

    const b = await browser();
    const unknown = await b.post("/auth/forgot-password", { email: "nobody@example.com" }).expect(200);
    const known = await b.post("/auth/forgot-password", { email: "reset@example.com" }).expect(200);
    expect(known.body).toEqual(unknown.body); // no account enumeration
    expect(sent).toHaveLength(1);
    const token = sent[0].text.match(/token=([A-Za-z0-9_-]{43})/)[1];
    expect(sent[0].text).toContain("http://localhost:5173/reset-password?token=");

    await b.post("/auth/reset-password", { token, password: "short" }).expect(400);
    await b.post("/auth/reset-password", { token, password: "a-fresh-password" }).expect(200);
    await b.post("/auth/reset-password", { token, password: "another-password" }).expect(400); // single use
    await old.get("/auth/me").expect(401);
    expect(await Session.countDocuments({ user: user._id, revokedAt: null })).toBe(0);
    await b.post("/auth/login", { email: user.email, password: "a-fresh-password" }).expect(200);
  });

  it("expired links don't work", async () => {
    const sent = mockMail();
    await createUser({ email: "late@example.com" });
    const b = await browser();
    await b.post("/auth/forgot-password", { email: "late@example.com" }).expect(200);
    const token = sent[0].text.match(/token=([A-Za-z0-9_-]{43})/)[1];
    const { PasswordReset } = await import("../src/models/commerce.js");
    await PasswordReset.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
    expect((await b.post("/auth/reset-password", { token, password: "a-fresh-password" }).expect(400)).body.error.code).toBe("INVALID_RESET_LINK");
  });
});
