import { Coupon, Order } from "../models/commerce.js";
import { round2 } from "../models/shared.js";

/* Pure totals calculation shared by cart, checkout and order creation.
   Order of application: coupon on the subtotal, then the prepaid discount on what remains;
   shipping is free once (subtotal − coupon) reaches the threshold. */
export function computeTotals({ subtotal, mrpTotal, couponDiscount = 0, paymentMethod, commerce }) {
  const afterCoupon = round2(Math.max(0, subtotal - couponDiscount));
  const prepaidDiscount = paymentMethod === "razorpay" ? Math.round((afterCoupon * commerce.prepaidOffPct) / 100) : 0;
  const shippingFee = subtotal === 0 || afterCoupon >= commerce.freeShippingAbove ? 0 : commerce.shippingFee;
  const total = round2(afterCoupon - prepaidDiscount + shippingFee);
  return {
    subtotal: round2(subtotal), mrpTotal: round2(mrpTotal), mrpSavings: round2(Math.max(0, mrpTotal - subtotal)),
    couponDiscount: round2(couponDiscount), prepaidDiscount, shippingFee, total,
    freeShippingRemaining: round2(Math.max(0, commerce.freeShippingAbove - afterCoupon)),
  };
}

/* Checks a coupon against the current subtotal. Returns { discount, error }. */
export async function evaluateCoupon(code, subtotal, { userId, phone, now = new Date(), session } = {}) {
  if (!code) return { coupon: null, discount: 0, error: null };
  const coupon = await Coupon.findOne({ code: String(code).toUpperCase() }).session(session || null).lean();
  const invalid = (error) => ({ coupon: null, discount: 0, error });
  if (!coupon || coupon.status !== "active") return invalid(`“${code}” isn’t a valid code.`);
  if (coupon.startsAt && coupon.startsAt > now) return invalid(`“${code}” isn’t active yet.`);
  if (coupon.endsAt && coupon.endsAt < now) return invalid(`“${code}” has expired.`);
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) return invalid(`“${code}” has reached its usage limit.`);
  if (coupon.perUserLimit && (userId || phone)) {
    const used = await Order.countDocuments({
      couponCode: coupon.code, status: { $nin: ["cancelled", "pending_payment"] },
      $or: [...(userId ? [{ user: userId }] : []), ...(phone ? [{ "contact.phone": phone }] : [])],
    }).session(session || null);
    if (used >= coupon.perUserLimit) return invalid(`You’ve already used “${code}”.`);
  }
  if (subtotal < coupon.minSubtotal) {
    return { coupon, discount: 0, error: `Add ₹${round2(coupon.minSubtotal - subtotal).toLocaleString("en-IN")} more to use ${coupon.code}`, belowMinimum: true };
  }
  let discount = coupon.type === "percent" ? Math.round((subtotal * coupon.value) / 100) : coupon.value;
  if (coupon.maxDiscount) discount = Math.min(discount, coupon.maxDiscount);
  return { coupon, discount: round2(Math.min(discount, subtotal)), error: null };
}

export const couponLabel = (c) => c.description || (c.type === "percent" ? `${c.value}% off` : `₹${c.value} off`) + (c.minSubtotal ? ` on ₹${c.minSubtotal.toLocaleString("en-IN")}+` : "");
