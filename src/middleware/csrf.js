import crypto from "node:crypto";
import { allowedOrigins } from "../config/env.js";
import { AppError } from "../utils/AppError.js";
import { csrfCookieOptions } from "../services/tokenService.js";

export const CSRF_COOKIE = "sz_csrf";
export const CSRF_HEADER = "x-csrf-token";
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/* GET /csrf — returns the token in the body (the frontends live on other origins and can't read
   API cookies) and sets the same value in an httpOnly cookie. */
export function issueCsrfToken(req, res) {
  let token = req.cookies?.[CSRF_COOKIE];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    token = crypto.randomBytes(32).toString("base64url");
    res.cookie(CSRF_COOKIE, token, csrfCookieOptions());
  }
  res.json({ success: true, data: { csrfToken: token } });
}

const equal = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length
  && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/* Two layers for state-changing requests: a browser Origin must be one of ours, and the
   X-CSRF-Token header must match the CSRF cookie (double-submit). Paths in `exempt`
   (signed webhooks) skip both. */
export const csrfProtection = ({ exempt = [] } = {}) => (req, _res, next) => {
  if (SAFE.has(req.method) || exempt.some((p) => req.path.startsWith(p))) return next();
  const origin = req.get("origin");
  if (origin && !allowedOrigins.includes(origin)) throw new AppError(403, "BAD_ORIGIN", "Request origin not allowed.");
  if (!equal(req.get(CSRF_HEADER), req.cookies?.[CSRF_COOKIE])) {
    throw new AppError(403, "CSRF_INVALID", "Your session security token is missing or expired. Please refresh the page and try again.");
  }
  next();
};
