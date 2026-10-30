import mongoose from "mongoose";
import { toJSONPlugin } from "./plugins.js";

const { ObjectId, Mixed } = mongoose.Schema.Types;

/* ---------- Inventory movements: every stock change, with its reason ---------- */
const inventoryMovementSchema = new mongoose.Schema({
  product: { type: ObjectId, ref: "Product", required: true, index: true },
  variant: { type: ObjectId, required: true },
  sku: String,
  delta: { type: Number, required: true },
  reason: { type: String, enum: ["order", "order_cancelled", "reservation_expired", "late_payment", "adjustment", "restock", "return", "initial"], required: true },
  order: { type: ObjectId, ref: "Order" },
  actor: { type: ObjectId, ref: "User" },
  note: { type: String, maxlength: 300 },
}, { timestamps: { createdAt: true, updatedAt: false } });
inventoryMovementSchema.index({ createdAt: -1 });
toJSONPlugin(inventoryMovementSchema);
export const InventoryMovement = mongoose.model("InventoryMovement", inventoryMovementSchema);

/* ---------- Cart: one per customer, or per guest browser (guestId cookie) ---------- */
const cartSchema = new mongoose.Schema({
  user: { type: ObjectId, ref: "User" },
  guestId: { type: String },
  items: [{
    product: { type: ObjectId, ref: "Product", required: true },
    variant: { type: ObjectId, required: true },
    qty: { type: Number, required: true, min: 1, max: 10 },
  }],
  couponCode: { type: String, default: null },
}, { timestamps: true });
cartSchema.index({ user: 1 }, { unique: true, partialFilterExpression: { user: { $type: "objectId" } } });
cartSchema.index({ guestId: 1 }, { unique: true, partialFilterExpression: { guestId: { $type: "string" } } });
// Abandoned guest carts are removed after 60 days.
cartSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 60 * 86_400, partialFilterExpression: { guestId: { $type: "string" } } });
toJSONPlugin(cartSchema);
export const Cart = mongoose.model("Cart", cartSchema);

/* ---------- Coupons ---------- */
const couponSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true, match: /^[A-Z0-9_-]{3,30}$/ },
  description: { type: String, maxlength: 120, default: "" },
  type: { type: String, enum: ["percent", "fixed"], required: true },
  value: { type: Number, required: true, min: 0 },
  minSubtotal: { type: Number, min: 0, default: 0 },
  maxDiscount: { type: Number, min: 0, default: null },
  startsAt: Date,
  endsAt: Date,
  usageLimit: { type: Number, min: 1, default: null },
  perUserLimit: { type: Number, min: 1, default: null },
  usedCount: { type: Number, default: 0 },
  status: { type: String, enum: ["active", "disabled"], default: "active" },
}, { timestamps: true });
toJSONPlugin(couponSchema);
export const Coupon = mongoose.model("Coupon", couponSchema);

/* ---------- Orders ---------- */
export const ORDER_STATUSES = ["pending_payment", "placed", "confirmed", "packed", "shipped", "delivered", "cancelled", "returned"];
export const PAYMENT_STATUSES = ["pending", "paid", "failed", "refunded", "partially_refunded"];

const addressSnapshot = {
  name: String, phone: String, line1: String, line2: String, city: String, state: String, pincode: String,
};

const orderSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true, unique: true },
  user: { type: ObjectId, ref: "User", index: true },
  guestId: { type: String, index: true, sparse: true }, // guest browser that placed it (never returned by the API)
  contact: { name: { type: String, required: true }, email: String, phone: { type: String, required: true } },
  // Prices and names as they were at purchase time; later product edits don't change orders.
  items: [{
    product: { type: ObjectId, ref: "Product" },
    variant: ObjectId,
    sku: String, name: String, slug: String, image: String, color: String, size: String,
    price: Number, mrp: Number, qty: Number, lineTotal: Number,
    _id: false,
  }],
  shippingAddress: addressSnapshot,
  subtotal: Number,
  mrpTotal: Number,
  couponCode: String,
  couponDiscount: { type: Number, default: 0 },
  prepaidDiscount: { type: Number, default: 0 },
  shippingFee: { type: Number, default: 0 },
  tax: { type: Number, default: 0 }, // prices are tax-inclusive
  total: { type: Number, required: true },
  currency: { type: String, default: "INR" },
  paymentMethod: { type: String, enum: ["cod", "razorpay"], required: true },
  paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: "pending", index: true },
  status: { type: String, enum: ORDER_STATUSES, required: true, index: true },
  stockReserved: { type: Boolean, default: false },
  reservationExpiresAt: Date,
  needsAttention: { type: String, default: null }, // e.g. paid after reservation expired and stock ran out
  refundRequired: { type: Boolean, default: false },
  refundedAmount: { type: Number, default: 0 },
  fulfilment: {
    courier: String, trackingNumber: String, trackingUrl: String, shippedAt: Date, deliveredAt: Date,
  },
  notes: { type: String, maxlength: 500 },
  cancelReason: String,
  history: [{ status: String, note: String, by: { type: ObjectId, ref: "User" }, at: { type: Date, default: Date.now }, _id: false }],
  idempotencyKey: String,
  placedAt: Date,
}, { timestamps: true });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ "contact.phone": 1 });
orderSchema.index({ status: 1, reservationExpiresAt: 1 });
orderSchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } });
toJSONPlugin(orderSchema, { hidden: ["guestId", "idempotencyKey"] });
export const Order = mongoose.model("Order", orderSchema);

/* ---------- Payments (one per payment attempt / COD collection) ---------- */
const paymentSchema = new mongoose.Schema({
  order: { type: ObjectId, ref: "Order", required: true, index: true },
  provider: { type: String, enum: ["razorpay", "cod"], required: true },
  providerOrderId: { type: String, index: true },
  providerPaymentId: { type: String },
  amount: { type: Number, required: true },
  currency: { type: String, default: "INR" },
  status: { type: String, enum: ["created", "authorized", "captured", "failed", "refunded", "partially_refunded", "pending"], default: "created", index: true },
  method: String, // upi, card, netbanking… as reported by the gateway
  errorCode: String,
  errorDescription: String,
  refunds: [{ refundId: String, amount: Number, status: String, at: { type: Date, default: Date.now }, by: { type: ObjectId, ref: "User" }, _id: false }],
  refundedAmount: { type: Number, default: 0 },
}, { timestamps: true });
paymentSchema.index({ providerPaymentId: 1 }, { unique: true, partialFilterExpression: { providerPaymentId: { $type: "string" } } });
paymentSchema.index({ createdAt: -1 });
toJSONPlugin(paymentSchema);
export const Payment = mongoose.model("Payment", paymentSchema);

/* ---------- Webhook events already processed (idempotency) ---------- */
const webhookEventSchema = new mongoose.Schema({
  provider: { type: String, required: true },
  eventId: { type: String, required: true },
  type: String,
  payload: Mixed,
  processedAt: Date,
}, { timestamps: true });
webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
export const WebhookEvent = mongoose.model("WebhookEvent", webhookEventSchema);

/* ---------- Sequential counters (order numbers) ---------- */
const counterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });
export const Counter = mongoose.model("Counter", counterSchema);

export async function nextSequence(name, session) {
  const c = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { upsert: true, new: true, session });
  return c.seq;
}

/* ---------- Password reset tokens (hashed, single use, 1 hour) ---------- */
const passwordResetSchema = new mongoose.Schema({
  user: { type: ObjectId, ref: "User", required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  usedAt: Date,
}, { timestamps: true });
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86_400 });
export const PasswordReset = mongoose.model("PasswordReset", passwordResetSchema);

/* ---------- Uploaded assets: only images uploaded through our endpoint can be attached ---------- */
const uploadSchema = new mongoose.Schema({
  publicId: { type: String, required: true, unique: true },
  url: { type: String, required: true },
  kind: { type: String, required: true },
  bytes: Number, width: Number, height: Number, format: String,
  uploadedBy: { type: ObjectId, ref: "User" },
}, { timestamps: true });
toJSONPlugin(uploadSchema);
export const Upload = mongoose.model("Upload", uploadSchema);
