import mongoose from "mongoose";
import { toJSONPlugin } from "./plugins.js";
import { imageSchema } from "./shared.js";

const { ObjectId, Mixed } = mongoose.Schema.Types;

/* ---------- Inventory movements: every stock change, with its reason ---------- */
export const MOVEMENT_REASONS = ["order", "order_cancelled", "reservation_expired", "late_payment", "adjustment", "restock", "return", "initial", "damaged", "correction"];
// Reasons an admin may pick for a manual adjustment.
export const MANUAL_STOCK_REASONS = ["adjustment", "restock", "return", "damaged", "correction"];
const inventoryMovementSchema = new mongoose.Schema({
  product: { type: ObjectId, ref: "Product", required: true, index: true },
  variant: { type: ObjectId, required: true },
  sku: String,
  delta: { type: Number, required: true },
  reason: { type: String, enum: MOVEMENT_REASONS, required: true },
  // How a manual change was entered (add / remove / set exact). Empty for automatic movements.
  mode: { type: String, enum: ["add", "remove", "set", null], default: null },
  // Variant stock before and after this movement (recorded for movements made from v2 on; older rows lack them).
  before: { type: Number, default: null },
  after: { type: Number, default: null },
  order: { type: ObjectId, ref: "Order" },
  returnRequest: { type: ObjectId, ref: "ReturnRequest" },
  actor: { type: ObjectId, ref: "User" },
  note: { type: String, maxlength: 300 },
}, { timestamps: { createdAt: true, updatedAt: false } });
inventoryMovementSchema.index({ createdAt: -1 });
inventoryMovementSchema.index({ product: 1, variant: 1, createdAt: -1 });
inventoryMovementSchema.index({ reason: 1, createdAt: -1 });
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
  // Set while a refund call to the gateway is in flight, so a double click can't refund twice.
  refundLockedAt: { type: Date, default: null },
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
  // Non-sensitive details Razorpay returns (never a full card number or CVV — Razorpay doesn't send them).
  methodDetails: {
    bank: String, wallet: String, vpa: String,
    cardNetwork: String, cardType: String, cardLast4: String, cardIssuer: String,
    _id: false,
  },
  errorCode: String,
  errorDescription: String,
  errorSource: String,
  errorStep: String,
  errorReason: String,
  capturedAt: Date,
  refunds: [{
    refundId: String, amount: Number,
    // Razorpay: pending | processed | failed. Manual (COD) refunds are recorded as processed.
    status: String,
    at: { type: Date, default: Date.now }, by: { type: ObjectId, ref: "User" },
    processedAt: Date, failedAt: Date, failureReason: String, reason: String,
    returnRequest: { type: ObjectId, ref: "ReturnRequest" },
    manual: { type: Boolean, default: false },
    _id: false,
  }],
  refundedAmount: { type: Number, default: 0 },
}, { timestamps: true });
paymentSchema.index({ providerPaymentId: 1 }, { unique: true, partialFilterExpression: { providerPaymentId: { $type: "string" } } });
paymentSchema.index({ createdAt: -1 });
paymentSchema.index({ method: 1, createdAt: -1 });
paymentSchema.index({ "refunds.refundId": 1 });
toJSONPlugin(paymentSchema);
export const Payment = mongoose.model("Payment", paymentSchema);

/* ---------- Return requests (customer-initiated, admin-reviewed) ---------- */
export const RETURN_STATUSES = ["requested", "approved", "rejected", "pickup_scheduled", "in_transit", "received", "inspected", "completed", "cancelled"];
export const RETURN_REFUND_STATUSES = ["not_applicable", "pending", "processing", "completed", "failed"];
/* Default return reasons. Admins can add, rename and disable reasons (settings key "returns"); each request
   stores the reason code and the label shown at the time. */
export const DEFAULT_RETURN_REASONS = [
  { code: "damaged", label: "Damaged product", active: true, requiresComment: false },
  { code: "wrong_item", label: "Wrong product delivered", active: true, requiresComment: false },
  { code: "defective", label: "Defective product", active: true, requiresComment: false },
  { code: "size_fit", label: "Size or fit issue", active: true, requiresComment: false },
  { code: "not_as_described", label: "Product not as described", active: true, requiresComment: false },
  { code: "missing_items", label: "Missing items", active: true, requiresComment: false },
  { code: "changed_mind", label: "Changed mind", active: true, requiresComment: false },
  { code: "other", label: "Other", active: true, requiresComment: true },
];
export const RETURN_REASON_CODE = /^[a-z0-9_]{2,40}$/;
export const ITEM_CONDITIONS = ["good", "opened", "damaged", "unsellable"];

const returnItemSchema = new mongoose.Schema({
  product: { type: ObjectId, ref: "Product" },
  variant: ObjectId,
  sku: String, name: String, image: String, color: String, size: String,
  price: Number, // unit price paid, from the order
  qty: { type: Number, required: true, min: 1 },
  condition: { type: String, enum: [...ITEM_CONDITIONS, null], default: null },
  restockedQty: { type: Number, default: 0 },
}, { _id: false });

const returnRequestSchema = new mongoose.Schema({
  returnNumber: { type: String, required: true, unique: true },
  order: { type: ObjectId, ref: "Order", required: true, index: true },
  orderNumber: { type: String, required: true, index: true },
  user: { type: ObjectId, ref: "User", index: true },
  guestId: String,
  contact: { name: String, email: String, phone: String },
  items: { type: [returnItemSchema], validate: [(v) => v.length > 0, "Choose at least one item to return."] },
  reason: { type: String, required: true, match: RETURN_REASON_CODE, index: true },
  reasonLabel: { type: String, maxlength: 80 },
  comments: { type: String, maxlength: 1000, default: "" },
  evidence: { type: [imageSchema], default: [] },
  status: { type: String, enum: RETURN_STATUSES, default: "requested", index: true },
  adminNote: { type: String, maxlength: 1000, default: "" },
  rejectionReason: { type: String, maxlength: 500, default: "" },
  decidedBy: { type: ObjectId, ref: "User" },
  decidedAt: Date,
  pickup: { courier: String, trackingNumber: String, scheduledAt: Date, _id: false },
  receivedAt: Date,
  inspectedAt: Date,
  inspectedBy: { type: ObjectId, ref: "User" },
  inspectionNotes: { type: String, maxlength: 1000, default: "" },
  completedAt: Date,
  refund: {
    status: { type: String, enum: RETURN_REFUND_STATUSES, default: "not_applicable" },
    amount: Number,
    refundId: String,
    payment: { type: ObjectId, ref: "Payment" },
    providerPaymentId: String,
    initiatedAt: Date, completedAt: Date, failedAt: Date,
    failureReason: String,
    by: { type: ObjectId, ref: "User" },
    _id: false,
  },
  history: [{ status: String, refundStatus: String, note: String, by: { type: ObjectId, ref: "User" }, at: { type: Date, default: Date.now }, _id: false }],
}, { timestamps: true });
returnRequestSchema.index({ createdAt: -1 });
returnRequestSchema.index({ "refund.status": 1, createdAt: -1 });
returnRequestSchema.index({ "refund.refundId": 1 });
returnRequestSchema.index({ "contact.name": 1 });
toJSONPlugin(returnRequestSchema, { hidden: ["guestId"] });
export const ReturnRequest = mongoose.model("ReturnRequest", returnRequestSchema);

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
