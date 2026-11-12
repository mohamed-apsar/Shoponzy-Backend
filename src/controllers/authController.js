import * as authService from "../services/authService.js";
import { AUDIENCES, clearAuthCookies, setAuthCookies } from "../services/tokenService.js";
import { created, ok } from "../utils/respond.js";
import { GUEST_CART_COOKIE, mergeGuestCart } from "../services/cartService.js";
import { clearGuestCookie } from "../middleware/cartOwner.js";
import { Order } from "../models/commerce.js";

const ctx = (req) => ({ ip: req.ip, userAgent: req.get("user-agent") });

/* A guest bag built before signing in joins the account's bag. */
async function adoptGuestCart(req, res, userId) {
  const guestId = req.cookies?.[GUEST_CART_COOKIE];
  if (!guestId) return;
  await mergeGuestCart(guestId, userId);
  // Keep orders placed in this browser available after the customer signs in.
  await Order.updateMany(
    { guestId, user: { $exists: false }, status: { $ne: "pending_payment" } },
    { $set: { user: userId }, $unset: { guestId: "" } },
  );
  clearGuestCookie(res);
}

export async function register(req, res) {
  const { user, tokens } = await authService.register(req.valid.body, ctx(req));
  setAuthCookies(res, "customer", tokens);
  await adoptGuestCart(req, res, user._id);
  created(res, { user });
}

/* Handlers below are shared by the customer and admin routers; `audience` is bound per router. */
export const login = (audience) => async (req, res) => {
  const { user, tokens } = await authService.login(req.valid.body, audience, ctx(req));
  setAuthCookies(res, audience, tokens);
  if (audience === "customer") await adoptGuestCart(req, res, user._id);
  ok(res, { user });
};

export const refresh = (audience) => async (req, res) => {
  try {
    const { user, tokens } = await authService.refresh(req.cookies?.[AUDIENCES[audience].refresh], audience, ctx(req));
    setAuthCookies(res, audience, tokens);
    ok(res, { user });
  } catch (err) {
    clearAuthCookies(res, audience);
    throw err;
  }
};

export const logout = (audience) => async (req, res) => {
  await authService.logout({ sessionId: req.auth?.sessionId, refreshToken: req.cookies?.[AUDIENCES[audience].refresh], audience });
  clearAuthCookies(res, audience);
  ok(res, { signedOut: true });
};

export const me = (req, res) => ok(res, { user: req.auth.user });
