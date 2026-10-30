import { describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { API, PASSWORD, app, browser, cookie, cookieNames, createUser, useDb } from "./helpers.js";
import { User } from "../src/models/User.js";
import { Session } from "../src/models/Session.js";
import { env } from "../src/config/env.js";
import request from "supertest";

useDb();

const newCustomer = { name: "Asha Kumar", email: "Asha@Example.com", phone: "+91 98765 43210", password: PASSWORD };

describe("register", () => {
  it("creates a customer, hashes the password and signs them in with httpOnly cookies", async () => {
    const b = await browser();
    const res = await b.post("/auth/register", newCustomer).expect(201);

    expect(res.body.data.user).toMatchObject({ name: "Asha Kumar", email: "asha@example.com", phone: "9876543210", role: "customer", status: "active" });
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(cookieNames(res)).toEqual(expect.arrayContaining(["sz_at", "sz_rt"]));
    expect(cookie(res, "sz_at")).toMatch(/HttpOnly/);
    expect(cookie(res, "sz_at")).toMatch(/SameSite=Lax/);
    expect(cookie(res, "sz_rt")).toMatch(/Path=\/api\/v1\/auth/);

    const stored = await User.findOne({ email: "asha@example.com" }).select("+passwordHash");
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(stored.passwordHash).not.toContain(PASSWORD);
    await b.get("/auth/me").expect(200);
  });

  it("ignores attempts to self-assign a role", async () => {
    const b = await browser();
    await b.post("/auth/register", { ...newCustomer, role: "admin" }).expect(400);
    expect(await User.countDocuments()).toBe(0);
  });

  it("rejects a duplicate email (case-insensitive) with 409", async () => {
    await createUser({ email: "asha@example.com" });
    const b = await browser();
    const res = await b.post("/auth/register", newCustomer).expect(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("returns field-level validation errors", async () => {
    const b = await browser();
    const res = await b.post("/auth/register", { name: "A", email: "nope", phone: "123", password: "short" }).expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details.map((d) => d.path).sort()).toEqual(["email", "name", "password", "phone"]);
  });
});

describe("login", () => {
  it("signs in with correct credentials and records lastLoginAt", async () => {
    const user = await createUser({ email: "c@example.com" });
    const b = await browser();
    const res = await b.post("/auth/login", { email: "C@example.com", password: PASSWORD }).expect(200);
    expect(res.body.data.user.id).toBe(String(user._id));
    expect((await User.findById(user._id)).lastLoginAt).toBeInstanceOf(Date);
  });

  it("gives the same message for an unknown email and a wrong password", async () => {
    await createUser({ email: "c@example.com" });
    const b = await browser();
    const wrong = await b.post("/auth/login", { email: "c@example.com", password: "wrong-password" }).expect(401);
    const unknown = await b.post("/auth/login", { email: "nobody@example.com", password: "wrong-password" }).expect(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    expect(cookieNames(wrong)).not.toContain("sz_at");
  });

  it("refuses disabled accounts", async () => {
    await createUser({ email: "d@example.com", status: "disabled" });
    const b = await browser();
    await b.post("/auth/login", { email: "d@example.com", password: PASSWORD }).expect(403);
  });

  it("rejects NoSQL-operator payloads instead of matching any user", async () => {
    await createUser({ email: "c@example.com" });
    const b = await browser();
    await b.post("/auth/login", { email: { $ne: null }, password: { $ne: null } }).expect(400);
  });
});

describe("session lifecycle", () => {
  it("/me requires a session", async () => {
    await request(app).get(`${API}/auth/me`).expect(401);
  });

  it("rejects expired, forged and wrong-audience access tokens", async () => {
    const user = await createUser();
    const b = await browser();
    await b.post("/auth/login", { email: user.email, password: PASSWORD }).expect(200);
    const session = await Session.findOne({ user: user._id });
    const sign = (opts, secret = env.JWT_SECRET) => jwt.sign({ role: "customer", sid: String(session._id) }, secret, { subject: String(user._id), issuer: "shoponzy-api", ...opts });

    const expired = sign({ audience: "customer", expiresIn: -10 });
    const forged = sign({ audience: "customer", expiresIn: "5m" }, "x".repeat(40));
    const wrongAud = sign({ audience: "admin", expiresIn: "5m" });
    for (const token of [expired, forged, wrongAud]) {
      await request(app).get(`${API}/auth/me`).set("Cookie", `sz_at=${token}`).expect(401);
    }
  });

  it("refresh rotates the refresh token and keeps the user signed in", async () => {
    const user = await createUser();
    const b = await browser();
    const login = await b.post("/auth/login", { email: user.email, password: PASSWORD }).expect(200);
    const res = await b.post("/auth/refresh").expect(200);
    expect(cookie(res, "sz_rt")).not.toBe(cookie(login, "sz_rt"));
    const sessions = await Session.find({ user: user._id }).sort({ createdAt: 1 });
    expect(sessions).toHaveLength(2);
    expect(sessions[0].revokedReason).toBe("rotated");
    expect(String(sessions[0].replacedBy)).toBe(String(sessions[1]._id));
    await b.get("/auth/me").expect(200);
  });

  it("replaying a rotated refresh token revokes every session of that user", async () => {
    const user = await createUser();
    const b = await browser();
    const login = await b.post("/auth/login", { email: user.email, password: PASSWORD }).expect(200);
    const stolen = cookie(login, "sz_rt").split(";")[0];
    await b.post("/auth/refresh").expect(200);
    // Outside the concurrent-tab grace window.
    await Session.updateOne({ revokedReason: "rotated" }, { revokedAt: new Date(Date.now() - 60_000) });

    const attacker = await browser();
    await request(app).post(`${API}/auth/refresh`).set("X-CSRF-Token", attacker.token).set("Cookie", `${stolen}; sz_csrf=${attacker.token}`).expect(401);
    expect(await Session.countDocuments({ user: user._id, revokedAt: null })).toBe(0);
    await b.get("/auth/me").expect(401);
  });

  it("a concurrent refresh with the just-rotated token does not sign the user out", async () => {
    const user = await createUser();
    const b = await browser();
    const login = await b.post("/auth/login", { email: user.email, password: PASSWORD }).expect(200);
    const oldRt = cookie(login, "sz_rt").split(";")[0];
    await b.post("/auth/refresh").expect(200);
    const other = await browser();
    await request(app).post(`${API}/auth/refresh`).set("X-CSRF-Token", other.token).set("Cookie", `${oldRt}; sz_csrf=${other.token}`).expect(401);
    await b.get("/auth/me").expect(200);
  });

  it("logout revokes the session server-side, so a copied access token stops working", async () => {
    const user = await createUser();
    const b = await browser();
    const login = await b.post("/auth/login", { email: user.email, password: PASSWORD }).expect(200);
    const at = cookie(login, "sz_at").split(";")[0];
    const res = await b.post("/auth/logout").expect(200);
    expect(cookie(res, "sz_at")).toMatch(/Expires=Thu, 01 Jan 1970/);
    await request(app).get(`${API}/auth/me`).set("Cookie", at).expect(401);
    await b.post("/auth/refresh").expect(401);
  });

  it("logout still revokes the session when the access token has already expired", async () => {
    const user = await createUser();
    const b = await browser();
    const login = await b.post("/auth/login", { email: user.email, password: PASSWORD }).expect(200);
    const rt = cookie(login, "sz_rt").split(";")[0];
    await request(app).post(`${API}/auth/logout`).set("X-CSRF-Token", b.token).set("Cookie", `${rt}; sz_csrf=${b.token}`).expect(200);
    expect(await Session.countDocuments({ user: user._id, revokedAt: null })).toBe(0);
  });

  it("disabling an account ends its existing sessions immediately", async () => {
    const user = await createUser();
    const b = await browser();
    await b.post("/auth/login", { email: user.email, password: PASSWORD }).expect(200);
    await User.updateOne({ _id: user._id }, { status: "disabled" });
    await b.get("/auth/me").expect(401);
    await b.post("/auth/refresh").expect(401);
  });
});
