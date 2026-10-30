import { describe, expect, it } from "vitest";
import request from "supertest";
import { API, PASSWORD, app, browser, cookie, cookieNames, createUser, useDb } from "./helpers.js";
import { AuditLog } from "../src/models/AuditLog.js";

useDb();

async function adminBrowser() {
  const admin = await createUser({ email: "admin@shoponzy.in", role: "admin", name: "Store Admin" });
  const b = await browser();
  await b.post("/admin/auth/login", { email: admin.email, password: PASSWORD }).expect(200);
  return { admin, b };
}

describe("admin authentication", () => {
  it("admins sign in with separate cookies scoped to the admin API", async () => {
    await createUser({ email: "admin@shoponzy.in", role: "admin" });
    const b = await browser();
    const res = await b.post("/admin/auth/login", { email: "admin@shoponzy.in", password: PASSWORD }).expect(200);
    expect(cookieNames(res)).toEqual(expect.arrayContaining(["sz_admin_at", "sz_admin_rt"]));
    expect(cookieNames(res)).not.toContain("sz_at");
    expect(cookie(res, "sz_admin_rt")).toMatch(/Path=\/api\/v1\/admin\/auth/);
    await b.get("/admin/auth/me").expect(200);
    expect(await AuditLog.countDocuments({ action: "auth.admin_login" })).toBe(1);
  });

  it("customers cannot sign in to the admin panel, with the same message as a wrong password", async () => {
    const customer = await createUser();
    const b = await browser();
    const res = await b.post("/admin/auth/login", { email: customer.email, password: PASSWORD }).expect(401);
    expect(res.body.error.message).toBe("Invalid email or password.");
  });

  it("a customer session cannot reach admin endpoints", async () => {
    const customer = await createUser();
    const b = await browser();
    await b.post("/auth/login", { email: customer.email, password: PASSWORD }).expect(200);
    await b.get("/admin/users").expect(401);
    await b.get("/admin/auth/me").expect(401);
  });

  it("a customer access token renamed to the admin cookie is rejected (audience check)", async () => {
    const customer = await createUser();
    const b = await browser();
    const res = await b.post("/auth/login", { email: customer.email, password: PASSWORD }).expect(200);
    const token = cookie(res, "sz_at").split(";")[0].split("=")[1];
    await request(app).get(`${API}/admin/users`).set("Cookie", `sz_admin_at=${token}`).expect(401);
  });

  it("demoting an admin cuts off their admin session on the next request", async () => {
    const { admin, b } = await adminBrowser();
    admin.role = "customer";
    await admin.save();
    await b.get("/admin/users").expect(401);
  });

  it("admin and customer sessions coexist in one browser without interfering", async () => {
    const { b } = await adminBrowser();
    const shopper = await createUser({ email: "shopper@example.com" });
    await b.post("/auth/login", { email: shopper.email, password: PASSWORD }).expect(200);
    expect((await b.get("/auth/me").expect(200)).body.data.user.email).toBe("shopper@example.com");
    expect((await b.get("/admin/auth/me").expect(200)).body.data.user.email).toBe("admin@shoponzy.in");
    await b.post("/auth/logout").expect(200);
    await b.get("/admin/users").expect(200);
  });
});

describe("GET /admin/users", () => {
  it("lists customers with pagination, newest first, without password hashes", async () => {
    const { b } = await adminBrowser();
    for (let i = 0; i < 25; i++) await createUser({ name: `Customer ${String(i).padStart(2, "0")}`, email: `c${i}@example.com` });
    const res = await b.get("/admin/users?page=2&limit=10").expect(200);
    expect(res.body.meta).toEqual({ page: 2, limit: 10, total: 25, pages: 3 });
    expect(res.body.data).toHaveLength(10);
    expect(res.body.data[0].name).toBe("Customer 14");
    expect(res.body.data.every((u) => u.role === "customer" && !("passwordHash" in u))).toBe(true);
  });

  it("searches name, email and phone, treating regex characters literally", async () => {
    const { b } = await adminBrowser();
    await createUser({ name: "Priya S", email: "priya@example.com", phone: "9876500001" });
    await createUser({ name: "Rahul M", email: "rahul@example.com", phone: "9123400002" });
    expect((await b.get("/admin/users?q=priya").expect(200)).body.data).toHaveLength(1);
    expect((await b.get("/admin/users?q=91234").expect(200)).body.data[0].name).toBe("Rahul M");
    expect((await b.get("/admin/users?q=.*").expect(200)).body.data).toHaveLength(0);
  });

  it("filters by status and validates query parameters", async () => {
    const { b } = await adminBrowser();
    await createUser({ status: "disabled" });
    await createUser();
    expect((await b.get("/admin/users?status=disabled").expect(200)).body.meta.total).toBe(1);
    await b.get("/admin/users?limit=1000").expect(400);
    await b.get("/admin/users?status=banned").expect(400);
  });
});
