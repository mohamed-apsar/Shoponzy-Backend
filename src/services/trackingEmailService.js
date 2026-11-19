import { createHmac, randomInt } from "node:crypto";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";
import { emailEnabled, sendMail } from "./emailService.js";

const schema = new mongoose.Schema({
  _id: String,
  digest: { type: String, required: true },
  sentAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
  attempts: { type: Number, required: true },
}, { collection: "tracking_email_codes" });
const EmailCode = mongoose.model("TrackingEmailCode", schema);
const hmac = (value) => createHmac("sha256", env.JWT_SECRET).update(value).digest("hex");
const lookup = (phone, email) => hmac(`tracking-email:${phone}:${email}`);
const digestFor = (id, code) => hmac(`tracking-code:${id}:${code}`);

export function requireTrackingEmail() {
  if (!emailEnabled()) {
    throw new AppError(503, "TRACKING_EMAIL_UNAVAILABLE", "Email verification is currently unavailable. Please contact Shoponzy support for help with your order.");
  }
}

export async function sendTrackingEmail(phone, email) {
  requireTrackingEmail();
  const _id = lookup(phone, email);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const digest = digestFor(_id, code);
  const now = Date.now();
  try {
    await EmailCode.updateOne({ _id, sentAt: { $lte: new Date(now - 60_000) } }, {
      $set: { digest, sentAt: new Date(now), expiresAt: new Date(now + 10 * 60_000), attempts: 5 },
    }, { upsert: true });
  } catch (error) {
    if (error.code === 11000) return;
    throw error;
  }

  try {
    const response = await sendMail({
      to: email,
      subject: "Your Shoponzy order tracking code",
      text: `Your Shoponzy order tracking code is ${code}. It expires in 10 minutes. If you didn’t request it, you can ignore this email.`,
    });
    if (!response.sent) throw new Error("Email delivery did not start");
  } catch (error) {
    await EmailCode.deleteOne({ _id, digest });
    throw error;
  }
}

export async function verifyTrackingEmail(phone, email, code) {
  requireTrackingEmail();
  const _id = lookup(phone, email);
  const active = { _id, expiresAt: { $gt: new Date() }, attempts: { $gt: 0 } };
  if (await EmailCode.findOneAndUpdate({ ...active, digest: digestFor(_id, code) }, { $set: { attempts: 0 } })) return true;
  await EmailCode.updateOne(active, { $inc: { attempts: -1 } });
  return false;
}
