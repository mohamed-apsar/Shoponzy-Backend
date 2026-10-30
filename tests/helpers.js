import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, inject } from "vitest";
import mongoose from "mongoose";
import request from "supertest";
import { createApp } from "../src/app.js";
import { User } from "../src/models/User.js";
import { hashPassword } from "../src/services/authService.js";

export const app = createApp();
export const API = "/api/v1";
export const PASSWORD = "correct-horse-battery";

/* Own database per test file; emptied before each test. */
export function useDb() {
  beforeAll(async () => {
    await mongoose.connect(inject("mongoUri"), { dbName: `t_${crypto.randomBytes(4).toString("hex")}` });
    await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  });
  beforeEach(async () => {
    await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})));
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
}

/* A cookie-keeping browser stand-in that sends the CSRF header automatically. */
export async function browser() {
  const agent = request.agent(app);
  const res = await agent.get(`${API}/csrf`).expect(200);
  const token = res.body.data.csrfToken;
  const send = (method) => (url, body) => agent[method](API + url).set("X-CSRF-Token", token).send(body);
  return { agent, token, get: (url) => agent.get(API + url), post: send("post"), put: send("put"), patch: send("patch"), del: send("delete") };
}

export async function createUser(overrides = {}) {
  return User.create({
    name: "Test User", email: `user${crypto.randomBytes(3).toString("hex")}@example.com`,
    passwordHash: await hashPassword(overrides.password || PASSWORD), role: "customer", ...overrides, password: undefined,
  });
}

export const cookieNames = (res) => (res.headers["set-cookie"] || []).map((c) => c.split("=")[0]);
export const cookie = (res, name) => (res.headers["set-cookie"] || []).find((c) => c.startsWith(name + "="));
