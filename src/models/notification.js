import mongoose from "mongoose";
import { toJSONPlugin } from "./plugins.js";

const { ObjectId } = mongoose.Schema.Types;

/* ---------- Promotional email campaigns (sent to newsletter subscribers only) ---------- */
export const CAMPAIGN_TYPES = ["new_arrival", "offer", "sale"];
export const CAMPAIGN_STATUSES = ["draft", "sending", "sent", "cancelled"];

const campaignSchema = new mongoose.Schema({
  type: { type: String, enum: CAMPAIGN_TYPES, required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 120 }, // internal name
  subject: { type: String, required: true, trim: true, maxlength: 150 },
  headline: { type: String, trim: true, maxlength: 150, default: "" },
  message: { type: String, required: true, trim: true, maxlength: 5000 },
  products: [{ type: ObjectId, ref: "Product" }],
  couponCode: { type: String, trim: true, uppercase: true, maxlength: 30, default: "" },
  offerText: { type: String, trim: true, maxlength: 120, default: "" }, // e.g. "Flat 20% off"
  startsAt: Date, endsAt: Date, // sale period, shown in the email
  ctaLabel: { type: String, trim: true, maxlength: 40, default: "Shop now" },
  ctaUrl: { type: String, trim: true, maxlength: 500, default: "" },
  status: { type: String, enum: CAMPAIGN_STATUSES, default: "draft", index: true },
  stats: { total: { type: Number, default: 0 }, sent: { type: Number, default: 0 }, failed: { type: Number, default: 0 }, _id: false },
  cursor: { type: ObjectId, default: null }, // last subscriber processed (sending is resumable, in batches)
  lockedUntil: { type: Date, default: null }, // one batch at a time
  createdBy: { type: ObjectId, ref: "User" },
  sentBy: { type: ObjectId, ref: "User" },
  startedAt: Date, sentAt: Date,
  lastTestTo: String,
}, { timestamps: true });
campaignSchema.index({ createdAt: -1 });
toJSONPlugin(campaignSchema, { hidden: ["cursor", "lockedUntil"] });
export const Campaign = mongoose.model("Campaign", campaignSchema);

/* ---------- Email log: every email the store tries to send (kept 90 days) ---------- */
export const EMAIL_TYPES = ["order_confirmation", "order_status", "return_update", "support_reply", "support_ack", "campaign", "test", "password_reset", "other"];
const emailLogSchema = new mongoose.Schema({
  to: { type: String, maxlength: 254 },
  subject: { type: String, maxlength: 200 },
  type: { type: String, enum: EMAIL_TYPES, default: "other", index: true },
  status: { type: String, enum: ["sent", "failed", "skipped"], required: true, index: true },
  error: { type: String, maxlength: 300 },
  ref: String, // order number, return number, campaign id…
}, { timestamps: { createdAt: true, updatedAt: false } });
emailLogSchema.index({ createdAt: -1 });
emailLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86_400 });
toJSONPlugin(emailLogSchema);
export const EmailLog = mongoose.model("EmailLog", emailLogSchema);
