import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

/* Admin and customer sessions use separate cookies, so signing in to the storefront
   never grants admin access and the two never overwrite each other in one browser. */
export const AUDIENCES = {
  customer: { access: "sz_at", refresh: "sz_rt", refreshPath: "/api/v1/auth" },
  admin: { access: "sz_admin_at", refresh: "sz_admin_rt", refreshPath: "/api/v1/admin/auth" },
};
const ISSUER = "shoponzy-api";

const baseCookie = () => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAMESITE,
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
});

export function signAccessToken({ userId, role, sessionId, audience }) {
  return jwt.sign({ role, sid: String(sessionId) }, env.JWT_SECRET, {
    subject: String(userId), audience, issuer: ISSUER, expiresIn: `${env.ACCESS_TOKEN_TTL_MIN}m`, algorithm: "HS256",
  });
}

/* Throws if the token is invalid, expired, or was issued for the other audience. */
export function verifyAccessToken(token, audience) {
  return jwt.verify(token, env.JWT_SECRET, { audience, issuer: ISSUER, algorithms: ["HS256"] });
}

export const newRefreshToken = () => crypto.randomBytes(48).toString("base64url");
export const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
export const refreshExpiry = (audience = "customer") => {
  const ttlDays = audience === "admin" ? env.ADMIN_REFRESH_TOKEN_TTL_DAYS : env.REFRESH_TOKEN_TTL_DAYS;
  return new Date(Date.now() + ttlDays * 86_400_000);
};

export function setAuthCookies(res, audience, { accessToken, refreshToken, refreshExpiresAt }) {
  const names = AUDIENCES[audience];
  res.cookie(names.access, accessToken, { ...baseCookie(), path: "/api/v1", maxAge: env.ACCESS_TOKEN_TTL_MIN * 60_000 });
  res.cookie(names.refresh, refreshToken, { ...baseCookie(), path: names.refreshPath, expires: refreshExpiresAt });
}

export function clearAuthCookies(res, audience) {
  const names = AUDIENCES[audience];
  res.clearCookie(names.access, { ...baseCookie(), path: "/api/v1" });
  res.clearCookie(names.refresh, { ...baseCookie(), path: names.refreshPath });
}

export const csrfCookieOptions = () => ({ ...baseCookie(), path: "/" });
