import { User } from "../models/User.js";
import { Session } from "../models/Session.js";
import { AppError } from "../utils/AppError.js";
import { AUDIENCES, verifyAccessToken } from "../services/tokenService.js";

/* Resolves the signed-in user for an audience, or null. The session row is checked on every
   request, so logout, "disable account" and theft detection take effect immediately. */
async function resolve(req, audience) {
  const token = req.cookies?.[AUDIENCES[audience].access];
  if (!token) return null;
  let claims;
  try {
    claims = verifyAccessToken(token, audience);
  } catch {
    return null;
  }
  const [session, user] = await Promise.all([Session.findById(claims.sid), User.findById(claims.sub)]);
  if (!session || !session.isActive() || String(session.user) !== claims.sub) return null;
  if (!user || user.status !== "active") return null;
  if (audience === "admin" && user.role !== "admin") return null;
  return { user, sessionId: session._id, audience };
}

export const authenticate = (audience) => async (req, _res, next) => {
  const auth = await resolve(req, audience);
  if (!auth) throw AppError.unauthorized();
  req.auth = auth;
  next();
};

/* For routes that work for guests and signed-in customers alike (cart, checkout). */
export const optionalAuth = (audience) => async (req, _res, next) => {
  req.auth = await resolve(req, audience);
  next();
};

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.auth) throw AppError.unauthorized();
  if (!roles.includes(req.auth.user.role)) throw AppError.forbidden();
  next();
};
