import { env } from "../config/env.js";
import { GUEST_CART_COOKIE, newGuestId } from "../services/cartService.js";

const cookieOpts = () => ({
  httpOnly: true, secure: env.COOKIE_SECURE, sameSite: env.COOKIE_SAMESITE, path: "/api/v1", maxAge: 60 * 86_400_000,
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
});
const validGuestId = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{32}$/.test(v);

/* Sets req.owner = { userId } for signed-in customers, else { guestId }. Run after optionalAuth("customer").
   With { create: true } a guest without a cart cookie gets one. */
export const cartOwner = ({ create = false } = {}) => (req, res, next) => {
  if (req.auth) {
    req.owner = { userId: req.auth.user._id };
    return next();
  }
  let guestId = req.cookies?.[GUEST_CART_COOKIE];
  if (!validGuestId(guestId)) {
    guestId = create ? newGuestId() : null;
    if (guestId) res.cookie(GUEST_CART_COOKIE, guestId, cookieOpts());
  }
  req.owner = { guestId };
  next();
};

export const clearGuestCookie = (res) => res.clearCookie(GUEST_CART_COOKIE, { ...cookieOpts(), maxAge: undefined });
