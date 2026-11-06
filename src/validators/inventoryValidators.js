import { z } from "zod";
import { objectId, pagination } from "./common.js";
import { MOVEMENT_REASONS } from "../models/commerce.js";
import { PRODUCT_STATUSES } from "../models/Product.js";

const dateParam = z.coerce.date().optional();
// A date-only "to" (YYYY-MM-DD) means "up to the end of that day".
const toDate = z.string().trim().max(40).optional().transform((v, ctx) => {
  if (!v) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59.999Z` : v);
  if (Number.isNaN(d.getTime())) { ctx.addIssue({ code: "custom", message: "Invalid date." }); return z.NEVER; }
  return d;
});
export const dateRange = { from: dateParam, to: toDate };

export const inventoryQuery = z.object({
  ...pagination,
  q: z.string().trim().max(100).optional(),
  category: objectId.optional(),
  stockStatus: z.enum(["in", "low", "out", "inactive"]).optional(),
  productStatus: z.enum(PRODUCT_STATUSES).optional(),
  sort: z.enum(["stock_low", "stock_high", "name", "updated"]).default("stock_low"),
});

export const movementsQuery = z.object({
  ...pagination,
  q: z.string().trim().max(100).optional(),
  product: objectId.optional(),
  reason: z.enum(MOVEMENT_REASONS).optional(),
  manual: z.enum(["1", "true"]).transform(() => true).optional(),
  ...dateRange,
});

export const inventorySettingsSchema = z.object({
  lowStockThreshold: z.number().int().min(0).max(100_000),
}).strict();

export const productThresholdSchema = z.object({
  // null = use the store-wide threshold
  lowStockThreshold: z.number().int().min(0).max(100_000).nullable(),
}).strict();
