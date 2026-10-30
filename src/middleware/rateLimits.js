import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";

/* In-memory counters: correct for a single API instance. When running several instances,
   switch to a shared store (e.g. rate-limit-redis) — see backend/README.md. */
const limiter = (windowMs, limit, message, keyGenerator) => rateLimit({
  windowMs,
  limit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => !env.RATE_LIMIT_ENABLED,
  ...(keyGenerator ? { keyGenerator } : {}),
  handler: (_req, res) => res.status(429).json({ success: false, error: { code: "RATE_LIMITED", message } }),
});

const tooMany = "Too many attempts. Please wait a few minutes and try again.";

export const apiLimiter = limiter(60_000, 300, "Too many requests. Please slow down.");
export const loginIpLimiter = limiter(15 * 60_000, 10, tooMany);
// Slows password guessing spread across many IPs against one account.
export const loginAccountLimiter = limiter(60 * 60_000, 20, tooMany, (req) => `acct:${String(req.body?.email || "").toLowerCase().trim()}`);
export const registerLimiter = limiter(60 * 60_000, 10, tooMany);
export const refreshLimiter = limiter(15 * 60_000, 120, tooMany);
export const formLimiter = limiter(60 * 60_000, 20, "Too many submissions. Please try again later.");
export const checkoutLimiter = limiter(15 * 60_000, 30, "Too many checkout attempts. Please wait a few minutes.");
// Order ID + phone lookups: low limit so phone numbers can't be enumerated.
export const trackLimiter = limiter(15 * 60_000, 15, tooMany);
