import * as carts from "../services/cartService.js";
import { couponLabel, evaluateCoupon } from "../services/pricingService.js";
import { Coupon } from "../models/commerce.js";
import { AppError } from "../utils/AppError.js";
import { ok } from "../utils/respond.js";

/* Public offers shown on product pages. Only return coupons shoppers can currently use. */
export async function couponOffers(_req, res) {
  const now = new Date();
  const coupons = await Coupon.find({
    status: "active",
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
      { $or: [{ usageLimit: null }, { $expr: { $lt: ["$usedCount", "$usageLimit"] } }] },
    ],
  }).select("code description type value minSubtotal maxDiscount").sort({ createdAt: -1 }).lean();
  res.set("Cache-Control", "no-store");
  ok(res, coupons.map((coupon) => ({
    code: coupon.code,
    type: coupon.type,
    value: coupon.value,
    minSubtotal: coupon.minSubtotal || 0,
    maxDiscount: coupon.maxDiscount || null,
    label: couponLabel(coupon),
  })));
}

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
