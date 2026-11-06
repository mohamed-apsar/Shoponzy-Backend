import { z } from "zod";
import { objectId, pagination } from "./common.js";
import { ITEM_CONDITIONS, RETURN_REASONS, RETURN_REFUND_STATUSES, RETURN_STATUSES } from "../models/commerce.js";
import { dateRange } from "./inventoryValidators.js";

const note = z.string().trim().max(1000);

/* ---------- Customer ---------- */
export const createReturnSchema = z.object({
  items: z.array(z.object({ variantId: objectId, qty: z.number().int().min(1).max(100) }).strict()).min(1, "Choose at least one item to return.").max(50),
  reason: z.enum(RETURN_REASONS, { errorMap: () => ({ message: "Choose a return reason." }) }),
  comments: z.string().trim().max(1000).optional(),
  evidence: z.array(z.object({ publicId: z.string().trim().min(1).max(300) }).passthrough()).max(5, "Attach at most 5 photos.").optional(),
}).strict().superRefine((v, ctx) => {
  if (v.reason === "other" && !(v.comments && v.comments.length >= 5)) {
    ctx.addIssue({ code: "custom", path: ["comments"], message: "Tell us a little about the reason for the return." });
  }
});

/* ---------- Admin ---------- */
export const adminReturnsQuery = z.object({
  ...pagination,
  q: z.string().trim().max(100).optional(),
  status: z.enum(RETURN_STATUSES).optional(),
  refundStatus: z.enum(RETURN_REFUND_STATUSES).optional(),
  view: z.enum(["open", "approved", "refunds"]).optional(),
  sort: z.enum(["newest", "oldest", "updated"]).default("newest"),
  ...dateRange,
});
export const returnSummaryQuery = z.object({ ...dateRange });

export const approveReturnSchema = z.object({ note: note.optional() }).strict();
export const rejectReturnSchema = z.object({
  reason: z.string({ required_error: "Enter the reason for rejecting this return." }).trim().min(3, "Enter the reason for rejecting this return.").max(500),
  note: note.optional(),
}).strict();
export const returnStatusSchema = z.object({
  status: z.enum(["pickup_scheduled", "in_transit", "received", "completed", "cancelled"]),
  note: z.string().trim().max(300).optional(),
  pickup: z.object({
    courier: z.string().trim().max(60).optional(),
    trackingNumber: z.string().trim().max(60).optional(),
    scheduledAt: z.coerce.date().optional(),
  }).strict().optional(),
}).strict();
export const inspectReturnSchema = z.object({
  items: z.array(z.object({
    index: z.number().int().min(0).max(49),
    condition: z.enum(ITEM_CONDITIONS),
    restockQty: z.number().int().min(0).max(100),
  }).strict()).min(1).max(50),
  notes: note.optional(),
}).strict();
export const returnRefundSchema = z.object({
  amount: z.number().positive().max(10_000_000).optional(), // defaults to the most refundable for the returned items
  manualReference: z.string().trim().max(80).optional(), // COD refunds paid by bank/UPI
  note: z.string().trim().max(200).optional(),
}).strict();
