import crypto from "node:crypto";
import mongoose from "mongoose";
import { env, isProd } from "../config/env.js";
import { Campaign, EmailLog } from "../models/notification.js";
import { Coupon } from "../models/commerce.js";
import { Product } from "../models/Product.js";
import { NewsletterSubscriber } from "../models/site.js";
import { audit } from "../models/AuditLog.js";
import { AppError } from "../utils/AppError.js";
import { getSection } from "./settingsService.js";
import { campaignEmail, emailEnabled, sendMail } from "./emailService.js";

/* Promotional emails go only to newsletter subscribers (people who opted in). Each email carries a
   signed one-click unsubscribe link. Sending runs in small batches so each API request stays short
   (serverless time limits); the admin panel keeps calling until the campaign is sent. */

export const BATCH_SIZE = 25;
const LOCK_MS = 60_000;
const SUBSCRIBED = { status: "subscribed" };

/* ---------- Unsubscribe tokens ---------- */
export const unsubscribeToken = (email) => crypto.createHmac("sha256", env.JWT_SECRET).update(`unsubscribe:${String(email).toLowerCase()}`).digest("hex").slice(0, 32);
export function verifyUnsubscribe(email, token) {
  if (typeof email !== "string" || typeof token !== "string" || token.length !== 32) return false;
  return crypto.timingSafeEqual(Buffer.from(unsubscribeToken(email)), Buffer.from(token));
}
export function apiBaseUrl(req) {
  if (env.PUBLIC_API_URL) return env.PUBLIC_API_URL.replace(/\/$/, "");
  return `${isProd ? "https" : req.protocol}://${req.get("host")}/api/v1`;
}
const unsubscribeUrl = (base, email) => `${base}/newsletter/unsubscribe?e=${encodeURIComponent(email)}&t=${unsubscribeToken(email)}`;

async function shopUrl() {
  const general = await getSection("general");
  return (general.websiteUrl || env.CLIENT_URL).replace(/\/$/, "");
}

async function productCards(ids, shop) {
  if (!ids?.length) return [];
  const docs = await Product.find({ _id: { $in: ids }, status: "active" }).select("name slug images colors minPrice").lean();
  const byId = new Map(docs.map((p) => [String(p._id), p]));
  return ids.map((id) => byId.get(String(id))).filter(Boolean).map((p) => ({
    name: p.name, url: `${shop}/products/${p.slug}`, price: p.minPrice,
    image: p.images?.[0]?.url || p.colors?.find((c) => c.featuredImage)?.featuredImage?.url || null,
  }));
}

export async function renderCampaign(campaign, { base, to = "subscriber@example.com" }) {
  const shop = await shopUrl();
  return campaignEmail(campaign, { products: await productCards(campaign.products, shop), shopUrl: shop, unsubscribeUrl: unsubscribeUrl(base, to) });
}

/* ---------- CRUD ---------- */
async function checkInput(input) {
  if (input.couponCode) {
    const coupon = await Coupon.findOne({ code: input.couponCode.toUpperCase() }).lean();
    if (!coupon) throw AppError.badRequest(`There's no coupon "${input.couponCode}". Create it under Coupons first.`);
    if (coupon.status !== "active") throw AppError.badRequest(`Coupon "${coupon.code}" is disabled.`);
  }
  if (input.products?.length) {
    const found = await Product.countDocuments({ _id: { $in: input.products } });
    if (found !== new Set(input.products.map(String)).size) throw AppError.badRequest("One of the selected products no longer exists.");
  }
  if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) throw AppError.badRequest("The end date must be after the start date.");
}

export async function createCampaign(input, actor) {
  await checkInput(input);
  const c = await Campaign.create({ ...input, createdBy: actor._id });
  await audit("campaign.created", { actor: actor._id, entity: "Campaign", entityId: c._id, meta: { type: c.type, title: c.title } });
  return c;
}

export async function updateCampaign(id, input, actor) {
  const c = await Campaign.findById(id);
  if (!c) throw AppError.notFound("Notification not found.");
  if (c.status !== "draft") throw AppError.conflict("Only drafts can be edited. This notification has already been sent.");
  await checkInput({ ...c.toObject(), ...input });
  Object.assign(c, input);
  await c.save();
  await audit("campaign.updated", { actor: actor._id, entity: "Campaign", entityId: c._id, meta: { fields: Object.keys(input) } });
  return c;
}

export async function deleteCampaign(id, actor) {
  const c = await Campaign.findById(id);
  if (!c) throw AppError.notFound("Notification not found.");
  if (c.status === "sending") throw AppError.conflict("Stop sending before deleting this notification.");
  if (c.status === "sent") throw AppError.conflict("Sent notifications are kept as a record and can't be deleted.");
  await c.deleteOne();
  await audit("campaign.deleted", { actor: actor._id, entity: "Campaign", entityId: c._id });
}

export async function cancelCampaign(id, actor) {
  const c = await Campaign.findOneAndUpdate({ _id: id, status: "sending" }, { $set: { status: "cancelled", lockedUntil: null } }, { new: true });
  if (!c) throw AppError.conflict("This notification isn't being sent.");
  await audit("campaign.cancelled", { actor: actor._id, entity: "Campaign", entityId: c._id, meta: { stats: c.stats } });
  return c;
}

export async function sendTest(id, email, actor, base) {
  const c = await Campaign.findById(id);
  if (!c) throw AppError.notFound("Notification not found.");
  if (!emailEnabled()) throw new AppError(503, "EMAIL_NOT_CONFIGURED", "Email isn't set up on the server (SMTP settings are missing), so nothing can be sent yet.");
  const msg = await renderCampaign(c, { base, to: email });
  await sendMail({ to: email, ...msg, subject: `[TEST] ${msg.subject}`, type: "test", ref: String(c._id) }).catch((err) => {
    throw new AppError(502, "EMAIL_FAILED", `The test email could not be sent: ${err?.message || "mail server error"}.`);
  });
  c.lastTestTo = email;
  await c.save();
  await audit("campaign.test_sent", { actor: actor._id, entity: "Campaign", entityId: c._id, meta: { to: email } });
  return c;
}

/* Sends the next batch. The first call starts the campaign (draft → sending). Safe to call repeatedly. */
export async function sendNextBatch(id, actor, base) {
  if (!emailEnabled()) throw new AppError(503, "EMAIL_NOT_CONFIGURED", "Email isn't set up on the server (SMTP settings are missing), so nothing can be sent yet.");
  const now = new Date();
  const c = await Campaign.findOneAndUpdate(
    { _id: id, status: { $in: ["draft", "sending"] }, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
    { $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) } }, { new: true },
  );
  if (!c) {
    const existing = await Campaign.findById(id).lean();
    if (!existing) throw AppError.notFound("Notification not found.");
    if (["sent", "cancelled"].includes(existing.status)) return Campaign.findById(id);
    throw new AppError(409, "SEND_IN_PROGRESS", "This notification is already being sent from another window.");
  }
  try {
    if (c.status === "draft") {
      const total = await NewsletterSubscriber.countDocuments(SUBSCRIBED);
      if (!total) throw AppError.badRequest("There are no newsletter subscribers to send to yet.");
      c.status = "sending";
      c.stats = { total, sent: 0, failed: 0 };
      c.startedAt = now;
      c.sentBy = actor._id;
      c.cursor = null;
      await audit("campaign.started", { actor: actor._id, entity: "Campaign", entityId: c._id, meta: { total, type: c.type } });
    }
    const batch = await NewsletterSubscriber.find({ ...SUBSCRIBED, ...(c.cursor ? { _id: { $gt: c.cursor } } : {}) }).sort({ _id: 1 }).limit(BATCH_SIZE).lean();
    const shop = await shopUrl();
    const products = await productCards(c.products, shop);
    let sent = 0, failed = 0;
    for (const sub of batch) {
      const unsub = unsubscribeUrl(base, sub.email);
      const msg = campaignEmail(c, { products, shopUrl: shop, unsubscribeUrl: unsub });
      try {
        await sendMail({ to: sub.email, ...msg, type: "campaign", ref: String(c._id), headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
        sent++;
      } catch {
        failed++;
      }
    }
    // Cancelled from another window while this batch ran: keep the counts, stay cancelled.
    const fresh = await Campaign.findById(c._id).select("status").lean();
    if (fresh.status === "cancelled") c.status = "cancelled";
    c.stats.sent += sent;
    c.stats.failed += failed;
    if (batch.length) c.cursor = batch[batch.length - 1]._id;
    if (c.status === "sending" && batch.length < BATCH_SIZE) {
      c.status = "sent";
      c.sentAt = new Date();
      await audit("campaign.sent", { actor: actor._id, entity: "Campaign", entityId: c._id, meta: { stats: c.stats } });
    }
    c.lockedUntil = null;
    await c.save();
    return c;
  } catch (err) {
    await Campaign.updateOne({ _id: c._id }, { $set: { lockedUntil: null } });
    throw err;
  }
}

export async function notificationSummary() {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [subscribers, unsubscribed, byStatus, emails] = await Promise.all([
    NewsletterSubscriber.countDocuments(SUBSCRIBED),
    NewsletterSubscriber.countDocuments({ status: "unsubscribed" }),
    Campaign.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    EmailLog.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  const n = (rows, key) => rows.find((r) => r._id === key)?.n || 0;
  return {
    subscribers, unsubscribed, emailConfigured: emailEnabled(), mailFrom: env.MAIL_FROM,
    campaigns: { draft: n(byStatus, "draft"), sending: n(byStatus, "sending"), sent: n(byStatus, "sent"), cancelled: n(byStatus, "cancelled") },
    last30Days: { sent: n(emails, "sent"), failed: n(emails, "failed"), skipped: n(emails, "skipped") },
  };
}

export const isObjectId = (v) => mongoose.Types.ObjectId.isValid(v);
