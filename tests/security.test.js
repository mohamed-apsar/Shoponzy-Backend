import { describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import { API, PASSWORD, app, browser, createUser, useDb } from "./helpers.js";
import { makeErrorHandler } from "../src/middleware/errorHandler.js";

useDb();

describe("CSRF and origin checks", () => {
  it("rejects state-changing requests without a CSRF token", async () => {
    const res = await request(app).post(`${API}/auth/login`).send({ email: "a@example.com", password: "x" }).expect(403);
    expect(res.body.error.code).toBe("CSRF_INVALID");
  });

  it("rejects a token that doesn't match the CSRF cookie", async () => {
    const b = await browser();
    await b.agent.post(`${API}/auth/login`).set("X-CSRF-Token", "A".repeat(43)).send({}).expect(403);
  });

  it("rejects requests from origins that aren't ours, even with a valid token", async () => {
    const user = await createUser();
    const b = await browser();
    const res = await b.agent.post(`${API}/auth/login`).set("Origin", "https://evil.example").set("X-CSRF-Token", b.token)
      .send({ email: user.email, password: PASSWORD }).expect(403);
    expect(res.body.error.code).toBe("BAD_ORIGIN");
  });

  it("accepts the storefront and admin origins", async () => {
    const user = await createUser();
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5176"]) {
      const b = await browser();
      await b.agent.post(`${API}/auth/login`).set("Origin", origin).set("X-CSRF-Token", b.token).send({ email: user.email, password: PASSWORD }).expect(200);
    }
  });

  it("the CSRF endpoint reuses the existing token and sets it httpOnly", async () => {
    const b = await browser();
    const again = await b.get("/csrf").expect(200);
    expect(again.body.data.csrfToken).toBe(b.token);
    const fresh = await request(app).get(`${API}/csrf`).expect(200);
    expect(fresh.headers["set-cookie"][0]).toMatch(/^sz_csrf=.*HttpOnly/);
  });
});

describe("CORS and headers", () => {
  it("allows credentials only for known origins", async () => {
    const ok = await request(app).options(`${API}/auth/login`).set("Origin", "http://localhost:5173").set("Access-Control-Request-Method", "POST");
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(ok.headers["access-control-allow-credentials"]).toBe("true");
    const bad = await request(app).options(`${API}/auth/login`).set("Origin", "https://evil.example").set("Access-Control-Request-Method", "POST");
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("sends security headers and hides the framework", async () => {
    const res = await request(app).get(`${API}/health`).expect(200);
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.body.data).toMatchObject({ status: "ok", db: "connected" });
  });
});

describe("errors", () => {
  it("unknown routes return JSON 404", async () => {
    const res = await request(app).get(`${API}/nope`).expect(404);
    expect(res.body).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });

  it("malformed JSON returns 400, oversized bodies 413", async () => {
    const b = await browser();
    await b.agent.post(`${API}/auth/login`).set("X-CSRF-Token", b.token).set("Content-Type", "application/json").send("{bad json").expect(400);
    await b.post("/auth/login", { email: "a@example.com", password: "x".repeat(200_000) }).expect(413);
  });

  it("unexpected errors return a generic message without internals in production", async () => {
    const mini = express();
    mini.get("/boom", () => { throw new Error("db password is hunter2"); });
    mini.use(makeErrorHandler({ exposeInternals: false }));
    const res = await request(mini).get("/boom").expect(500);
    expect(res.body.error).toEqual({ code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." });
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
  });
});
