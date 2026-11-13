import { z } from "zod";
import { email, objectId, pagination } from "./common.js";
import { link } from "./siteValidators.js";
import { CAMPAIGN_STATUSES, CAMPAIGN_TYPES, EMAIL_TYPES } from "../models/notification.js";
import { CONTACT_STATUSES } from "../models/site.js";
import { dateRange } from "./inventoryValidators.js";

/* ---------- FAQs ---------- */
const faqBase = {
  question: z.string().trim().min(5, "Write the question (at least 5 characters).").max(300),
  answer: z.string().trim().min(2, "Write the answer.").max(5000),
  category: z.string().trim().min(2).max(60).optional(),
  order: z.number().int().min(0).max(10_000).optional(),
  status: z.enum(["active", "hidden"]).optional(),
};
export const createFaqSchema = z.object(faqBase).strict();
export const updateFaqSchema = z.object(faqBase).partial().strict();
export const faqListQuery = z.object({ ...pagination, limit: z.coerce.number().int().min(1).max(200).default(200), q: z.string().trim().max(100).optional(), status: z.enum(["active", "hidden"]).optional(), category: z.string().trim().max(60).optional() });
export const reorderIdsSchema = z.object({ ids: z.array(objectId).min(1).max(500) }).strict();

/* ---------- Notification campaigns ---------- */
const optionalDate = z.union([z.coerce.date(), z.null()]).optional();
const campaignBase = {
  type: z.enum(CAMPAIGN_TYPES),
  title: z.string().trim().min(2, "Give the notification a name.").max(120),
  subject: z.string().trim().min(3, "Write the email subject.").max(150),
  headline: z.string().trim().max(150).optional(),
  message: z.string().trim().min(5, "Write the message.").max(5000),
  products: z.array(objectId).max(12, "Pick at most 12 products.").optional(),
  couponCode: z.string().trim().toUpperCase().max(30).optional(),
  offerText: z.string().trim().max(120).optional(),
  startsAt: optionalDate, endsAt: optionalDate,
  ctaLabel: z.string().trim().max(40).optional(),
  ctaUrl: z.union([link, z.literal("")]).optional(),
};
export const createCampaignSchema = z.object(campaignBase).strict();
export const updateCampaignSchema = z.object(campaignBase).omit({ type: true }).partial().strict();
export const campaignListQuery = z.object({ ...pagination, type: z.enum(CAMPAIGN_TYPES).optional(), status: z.enum(CAMPAIGN_STATUSES).optional(), q: z.string().trim().max(100).optional() });
export const testSendSchema = z.object({ email }).strict();

export const notificationSettingsSchema = z.object({
  orderConfirmation: z.boolean(), orderShipped: z.boolean(), orderDelivered: z.boolean(), orderCancelled: z.boolean(),
  returnUpdates: z.boolean(), supportAutoReply: z.boolean(),
}).partial().strict();
export const emailLogQuery = z.object({ ...pagination, type: z.enum(EMAIL_TYPES).optional(), status: z.enum(["sent", "failed", "skipped"]).optional(), q: z.string().trim().max(100).optional(), ...dateRange });

/* ---------- Help & Support ---------- */
export const supportListQuery = z.object({ ...pagination, q: z.string().trim().max(100).optional(), status: z.enum(CONTACT_STATUSES).optional(), topic: z.string().trim().max(60).optional(), ...dateRange });
export const supportReplySchema = z.object({
  message: z.string().trim().min(2, "Write a reply.").max(5000),
  sendEmail: z.boolean().default(true),
  close: z.boolean().default(false),
}).strict();
export const supportNoteSchema = z.object({ note: z.string().trim().min(2).max(2000) }).strict();
export const supportStatusSchema = z.object({ status: z.enum(CONTACT_STATUSES) }).strict();
