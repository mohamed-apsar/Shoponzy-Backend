import { z } from "zod";
import { email, name, objectId, pagination, phone } from "./common.js";
import { ORDER_STATUSES, PAYMENT_STATUSES } from "../models/commerce.js";
import { dateRange } from "./inventoryValidators.js";

export const addressSchema = z.object({
  label: z.string().trim().max(40).optional(),
  name,
  phone,
  line1: z.string().trim().min(5, "Enter house no., street and area.").max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(2, "Enter your city.").max(80),
  state: z.string().trim().min(2, "Choose your state.").max(80),
  pincode: z.string().trim().regex(/^\d{6}$/, "Enter a 6-digit PIN code."),
  isDefault: z.boolean().optional(),
}).strict();

/* ---------- Cart ---------- */
export const addCartItemSchema = z.object({ productId: objectId, variantId: objectId, qty: z.number().int().min(1).max(10).default(1) }).strict();
export const updateCartItemSchema = z.object({ qty: z.number().int().min(1).max(10) }).strict();
export const couponSchema = z.object({ code: z.string().trim().toUpperCase().max(30).nullable() }).strict();

/* ---------- Checkout ---------- */
export const checkoutSchema = z.object({
  contact: z.object({ name, email: z.union([email, z.literal("")]).optional().transform((v) => v || undefined), phone }).strict(),
  shippingAddress: addressSchema.omit({ label: true, isDefault: true }).optional(),
  addressId: objectId.optional(), // a saved address (signed-in customers)
  saveAddress: z.boolean().optional(),
  paymentMethod: z.enum(["cod", "razorpay"]),
  notes: z.string().trim().max(500).optional(),
  // Client-generated per checkout attempt; resubmitting returns the same order instead of a duplicate.
  idempotencyKey: z.string().trim().regex(/^[A-Za-z0-9_-]{16,64}$/).optional(),
}).strict().refine((v) => Boolean(v.shippingAddress) !== Boolean(v.addressId), { message: "Provide a delivery address.", path: ["shippingAddress"] });

export const trackOrderSchema = z.object({ orderNumber: z.string().trim().toUpperCase().regex(/^SZ\d{6,9}$/, "Check the order ID."), phone }).strict();
export const myOrdersQuery = z.object({ ...pagination });

export const verifyPaymentSchema = z.object({
  orderNumber: z.string().trim().toUpperCase().regex(/^SZ\d{6,9}$/),
  razorpayOrderId: z.string().trim().max(64),
  razorpayPaymentId: z.string().trim().max(64),
  razorpaySignature: z.string().trim().regex(/^[a-f0-9]{64}$/),
}).strict();

/* ---------- Admin: orders, coupons, transactions ---------- */
const dateParam = z.coerce.date().optional();
export const adminOrdersQuery = z.object({
  ...pagination,
  q: z.string().trim().max(100).optional(),
  status: z.enum(ORDER_STATUSES).optional(), paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  paymentMethod: z.enum(["cod", "razorpay"]).optional(),
  attention: z.enum(["1", "true"]).transform(() => true).optional(),
  from: dateParam, to: dateParam,
  customer: objectId.optional(),
});
export const updateOrderStatusSchema = z.object({
  status: z.enum(ORDER_STATUSES.filter((s) => s !== "pending_payment" && s !== "placed")),
  note: z.string().trim().max(300).optional(),
  fulfilment: z.object({ courier: z.string().trim().max(60).optional(), trackingNumber: z.string().trim().max(60).optional(), trackingUrl: z.string().trim().url().max(500).regex(/^https?:\/\//).optional() }).strict().optional(),
  restock: z.boolean().optional(),
}).strict();
export const updateFulfilmentSchema = z.object({
  courier: z.string().trim().max(60).optional(), trackingNumber: z.string().trim().max(60).optional(),
  trackingUrl: z.union([z.string().trim().url().max(500).regex(/^https?:\/\//), z.literal("")]).optional(),
  notes: z.string().trim().max(500).optional(),
}).strict();
export const refundSchema = z.object({
  amount: z.number().positive().max(10_000_000).optional(),
  reason: z.string().trim().max(200).optional(),
  manualReference: z.string().trim().max(80).optional(), // COD refunds paid by bank/UPI
}).strict();
export const cancelSchema = z.object({ reason: z.string().trim().max(200).optional() }).strict();

const couponBase = {
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/, "3–30 letters, numbers, - or _."),
  description: z.string().trim().max(120).optional(),
  type: z.enum(["percent", "fixed"]),
  value: z.number().positive(),
  minSubtotal: z.number().min(0).optional(),
  maxDiscount: z.number().positive().nullable().optional(),
  startsAt: z.coerce.date().nullable().optional(), endsAt: z.coerce.date().nullable().optional(),
  usageLimit: z.number().int().positive().nullable().optional(), perUserLimit: z.number().int().positive().nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
};
const couponRefine = (c, ctx) => {
  if (c.type === "percent" && c.value > 90) ctx.addIssue({ code: "custom", path: ["value"], message: "Percentage coupons can be at most 90%." });
  if (c.startsAt && c.endsAt && c.endsAt <= c.startsAt) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End must be after start." });
};
export const createCouponSchema = z.object(couponBase).strict().superRefine(couponRefine);
export const updateCouponSchema = z.object(couponBase).partial().strict().superRefine(couponRefine);
export const listQuery = z.object({ ...pagination, q: z.string().trim().max(100).optional(), status: z.string().max(20).optional() });
export const transactionsQuery = z.object({
  ...pagination,
  // success | failed | pending | refunded | partially_refunded (raw payment statuses are accepted too)
  status: z.string().trim().regex(/^[a-z_]{1,30}$/).optional(),
  provider: z.enum(["razorpay", "cod"]).optional(),
  method: z.enum(["upi", "card", "netbanking", "wallet", "emi", "paylater", "cod"]).optional(),
  sort: z.enum(["newest", "oldest", "amount_high", "amount_low"]).default("newest"),
  q: z.string().trim().max(100).optional(), ...dateRange,
});
export const refundsQuery = z.object({
  ...pagination,
  status: z.enum(["pending", "processed", "failed"]).optional(),
  q: z.string().trim().max(100).optional(), ...dateRange,
});
