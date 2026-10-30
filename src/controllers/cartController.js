import * as carts from "../services/cartService.js";
import { couponLabel, evaluateCoupon } from "../services/pricingService.js";
import { AppError } from "../utils/AppError.js";
import { ok } from "../utils/respond.js";

/* GET /coupons/:code — the public rules of a currently usable coupon, so the bag can show the
   discount before checkout. The order is still priced (and the coupon re-checked) server-side. */
export async function couponInfo(req, res) {
  const { coupon, error } = await evaluateCoupon(req.params.code, Number.MAX_SAFE_INTEGER);
  if (error || !coupon) throw new AppError(404, "INVALID_COUPON", error || "That code isn’t valid.");
  ok(res, { code: coupon.code, type: coupon.type, value: coupon.value, minSubtotal: coupon.minSubtotal || 0, maxDiscount: coupon.maxDiscount || null, label: couponLabel(coupon) });
}

const priced = async (req, cart) => carts.priceCart(cart || (await carts.getCart(req.owner)), { userId: req.owner.userId });

export const getCart = async (req, res) => ok(res, await priced(req));
export const addItem = async (req, res) => ok(res, await priced(req, await carts.addItem(req.owner, req.valid.body)));
export const updateItem = async (req, res) => ok(res, await priced(req, await carts.updateItem(req.owner, req.params.itemId, req.valid.body.qty)));
export const removeItem = async (req, res) => ok(res, await priced(req, await carts.removeItem(req.owner, req.params.itemId)));
export const setCoupon = async (req, res) => ok(res, await priced(req, await carts.setCoupon(req.owner, req.valid.body.code)));
