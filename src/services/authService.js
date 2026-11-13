import bcrypt from "bcryptjs";
import { env } from "../config/env.js";
import { User } from "../models/User.js";
import { Session } from "../models/Session.js";
import { audit } from "../models/AuditLog.js";
import { AppError } from "../utils/AppError.js";
import { logger } from "../utils/logger.js";
import { hashToken, newRefreshToken, refreshExpiry, signAccessToken } from "./tokenService.js";

const INVALID_LOGIN = "Invalid email or password.";
export const ROTATION_GRACE_MS = 10_000;
// Compared against when the email is unknown, so response time doesn't reveal which emails exist.
let dummyHash;
const getDummyHash = async () => (dummyHash ??= await bcrypt.hash("not-a-real-password", env.BCRYPT_ROUNDS));

export const hashPassword = (password) => bcrypt.hash(password, env.BCRYPT_ROUNDS);

async function startSession(user, audience, ctx) {
  const refreshToken = newRefreshToken();
  const session = await Session.create({
    user: user._id, audience, tokenHash: hashToken(refreshToken), expiresAt: refreshExpiry(audience),
    userAgent: ctx.userAgent?.slice(0, 300), ip: ctx.ip,
  });
  const accessToken = signAccessToken({ userId: user._id, role: user.role, sessionId: session._id, audience });
  return { accessToken, refreshToken, refreshExpiresAt: session.expiresAt, session };
}

export async function register({ name, email, phone, password }, ctx) {
  if (await User.exists({ email })) throw AppError.conflict("An account with this email already exists.");
  let user;
  try {
    user = await User.create({ name, email, phone, passwordHash: await hashPassword(password), role: "customer" });
  } catch (err) {
    if (err?.code === 11000) throw AppError.conflict("An account with this email already exists.");
    throw err;
  }
  const tokens = await startSession(user, "customer", ctx);
  return { user, tokens };
}

/* audience "admin" only accepts admins; "customer" accepts any active account. */
export async function login({ email, password }, audience, ctx) {
  const user = await User.findOne({ email }).select("+passwordHash");
  const valid = await bcrypt.compare(password, user?.passwordHash || (await getDummyHash()));
  if (!user || !valid) {
    if (audience === "admin") logger.warn({ email, ip: ctx.ip }, "Failed admin login");
    throw AppError.unauthorized(INVALID_LOGIN);
  }
  if (user.status !== "active") throw AppError.forbidden("This account has been disabled. Please contact support.");
  if (audience === "admin" && user.role !== "admin") throw AppError.unauthorized(INVALID_LOGIN);

  user.lastLoginAt = new Date();
  await user.save();
  const tokens = await startSession(user, audience, ctx);
  if (audience === "admin") await audit("auth.admin_login", { actor: user._id, ip: ctx.ip });
  return { user, tokens };
}

/* Rotates the refresh token. Reusing an already-rotated token revokes all of the user's sessions. */
export async function refresh(refreshToken, audience, ctx) {
  if (!refreshToken) throw AppError.unauthorized();
  const session = await Session.findOne({ tokenHash: hashToken(refreshToken), audience });
  if (!session) throw AppError.unauthorized();

  if (session.revokedAt) {
    // Two tabs refreshing at once is normal; only a late replay of a rotated token signals theft.
    const benignRace = Date.now() - session.revokedAt.getTime() < ROTATION_GRACE_MS;
    if (session.replacedBy && !benignRace) {
      await Session.updateMany({ user: session.user, revokedAt: null }, { revokedAt: new Date(), revokedReason: "refresh_token_reuse" });
      await audit("auth.refresh_reuse_detected", { actor: session.user, ip: ctx.ip, meta: { audience } });
      logger.warn({ user: String(session.user), ip: ctx.ip }, "Refresh token reuse detected; all sessions revoked");
    }
    throw AppError.unauthorized();
  }
  if (session.expiresAt <= new Date()) throw AppError.unauthorized();

  const user = await User.findById(session.user);
  if (!user || user.status !== "active" || (audience === "admin" && user.role !== "admin")) {
    session.revokedAt = new Date();
    session.revokedReason = "user_ineligible";
    await session.save();
    throw AppError.unauthorized();
  }

  // Claim the session atomically so concurrent refreshes can't both succeed with one token.
  const claimed = await Session.findOneAndUpdate({ _id: session._id, revokedAt: null }, { revokedAt: new Date(), revokedReason: "rotated" }, { new: true });
  if (!claimed) throw AppError.unauthorized();
  const tokens = await startSession(user, audience, ctx);
  claimed.replacedBy = tokens.session._id;
  await claimed.save();
  return { user, tokens };
}

/* Works with an expired access token too: falls back to the session behind the refresh cookie. */
export async function logout({ sessionId, refreshToken, audience }) {
  const revoke = { revokedAt: new Date(), revokedReason: "logout" };
  if (sessionId) await Session.updateOne({ _id: sessionId, revokedAt: null }, revoke);
  if (refreshToken) await Session.updateOne({ tokenHash: hashToken(refreshToken), audience, revokedAt: null }, revoke);
}

/* Used when an account is disabled or its password changes. */
export async function revokeAllSessions(userId, reason) {
  await Session.updateMany({ user: userId, revokedAt: null }, { revokedAt: new Date(), revokedReason: reason });
}
