import crypto from "node:crypto";
import Razorpay from "razorpay";
import { env, razorpayConfigured } from "../config/env.js";
import { AppError } from "../utils/AppError.js";

/* Thin wrapper over the Razorpay SDK; swappable in tests so no request leaves the machine. */
let client = null;
export function getRazorpay() {
  if (client) return client;
  if (!razorpayConfigured) throw new AppError(503, "PAYMENTS_NOT_CONFIGURED", "Online payment is not available right now. Please choose Cash on delivery.");
  const rp = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
  client = {
    keyId: env.RAZORPAY_KEY_ID,
    createOrder: (o) => rp.orders.create(o),
    fetchPayment: (id) => rp.payments.fetch(id),
    capturePayment: (id, amount, currency) => rp.payments.capture(id, amount, currency),
    fetchOrderPayments: (orderId) => rp.orders.fetchPayments(orderId).then((r) => r.items || []),
    refund: (paymentId, opts) => rp.payments.refund(paymentId, opts),
    fetchRefund: (paymentId, refundId) => rp.payments.fetchRefund(paymentId, refundId),
  };
  return client;
}
export const setRazorpayClient = (c) => { client = c; };

const safeEqual = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const hmac = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("hex");

/* Checkout callback: signature = HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
export function verifyCheckoutSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature }, secret = env.RAZORPAY_KEY_SECRET) {
  if (!secret) return false;
  return safeEqual(hmac(secret, `${razorpayOrderId}|${razorpayPaymentId}`), razorpaySignature);
}

/* Webhooks: signature = HMAC_SHA256(raw request body, webhook secret). */
export function verifyWebhookSignature(rawBody, signature, secret = env.RAZORPAY_WEBHOOK_SECRET) {
  if (!secret || !rawBody) return false;
  return safeEqual(hmac(secret, rawBody), signature);
}

export const toPaise = (rupees) => Math.round(rupees * 100);

/* The non-sensitive payment-method details Razorpay returns on a payment entity. Razorpay never sends a
   full card number or CVV; only the network/type/last 4 digits are kept (when present). */
export function paymentMethodDetails(p = {}) {
  const details = {
    bank: p.bank || undefined, wallet: p.wallet || undefined, vpa: p.vpa || undefined,
    cardNetwork: p.card?.network || undefined, cardType: p.card?.type || undefined,
    cardLast4: /^\d{4}$/.test(p.card?.last4 || "") ? p.card.last4 : undefined, cardIssuer: p.card?.issuer || undefined,
  };
  return Object.values(details).some(Boolean) ? details : undefined;
}

/* Failure details from a failed payment entity. */
export const paymentFailure = (p = {}) => ({
  code: p.error_code || undefined, description: p.error_description || undefined,
  source: p.error_source || undefined, step: p.error_step || undefined, reason: p.error_reason || undefined,
});
