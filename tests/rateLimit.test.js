import { describe, expect, it } from "vitest";
import { browser, createUser, useDb } from "./helpers.js";
import { env } from "../src/config/env.js";

// Separate file: limiter counters are per module instance, and the other suites run with limits off.
env.RATE_LIMIT_ENABLED = true;
useDb();

describe("login rate limiting", () => {
  it("blocks an IP after 10 attempts in 15 minutes, even with the right password", async () => {
    const user = await createUser({ email: "target@example.com" });
    const b = await browser();
    for (let i = 0; i < 10; i++) await b.post("/auth/login", { email: user.email, password: "wrong-password" }).expect(401);
    const res = await b.post("/auth/login", { email: user.email, password: "correct-horse-battery" }).expect(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(res.headers.ratelimit).toBeDefined();
  });
});
