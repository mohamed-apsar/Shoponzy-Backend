import { z } from "zod";
import { objectId, pagination } from "./common.js";
import { imageRef, robotsDirectivesSchema } from "./siteValidators.js";
import { BADGES, PRODUCT_STATUSES } from "../models/Product.js";
import { MANUAL_STOCK_REASONS } from "../models/commerce.js";

const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and hyphens.").max(80);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const money = z.coerce.number().min(0).max(10_000_000).refine((n) => Math.round(n * 100) === n * 100, "At most 2 decimal places.");
const seo = z.object({ title: z.string().trim().max(70).default(""), description: z.string().trim().max(160).default("") }).strict();
const productSeo = z.object({
  title: z.string().trim().max(70).optional(),
  description: z.string().trim().max(160).optional(),
  image: imageRef.optional(),
  robots: robotsDirectivesSchema.optional(),
}).strict();
const csv = (item) => z.union([z.array(item), z.string()]).transform((v) => (Array.isArray(v) ? v : v.split(",")).map((s) => String(s).trim()).filter(Boolean)).pipe(z.array(item).max(30));

/* ---------- Categories ---------- */
const categoryBase = {
  name: z.string().trim().min(1).max(80),
  slug,
  parent: objectId.nullable().optional(),
  description: z.string().trim().max(2000).optional(),
  brand: z.string().trim().max(80).optional(),
  image: imageRef.optional(),
  productImage: imageRef.optional(),
  exploreImage: imageRef.optional(),
  bannerImage: imageRef.optional(),
  order: z.coerce.number().int().min(0).max(10_000).optional(),
  status: z.enum(["enabled", "disabled"]).optional(),
  seo: seo.optional(),
  display: z.object({
    tagline: z.string().trim().max(80).optional(), color: hex.optional(), gradient: z.array(hex).max(2).optional(),
    artKind: z.string().max(20).optional(), artColor: hex.optional(),
    heroArt: z.array(z.object({ kind: z.string().max(20), color: hex })).max(3).optional(),
    bannerArt: z.object({ kind: z.string().max(20), color: hex }).optional(),
  }).strict().optional(),
};
export const createCategorySchema = z.object(categoryBase).strict();
export const updateCategorySchema = z.object(categoryBase).partial().strict();
export const listCategoriesQuery = z.object({
  ...pagination, limit: z.coerce.number().int().min(1).max(500).default(50),
  level: z.coerce.number().int().min(1).max(5).optional(), parent: objectId.optional(),
  status: z.enum(["enabled", "disabled"]).optional(), q: z.string().trim().max(80).optional(),
});

/* ---------- Products ---------- */
const variant = z.object({
  id: objectId.optional(),
  sku: z.string().trim().max(64).optional(),
  color: z.string().trim().max(40).nullable().default(null),
  size: z.string().trim().max(20).nullable().default(null),
  price: money, mrp: money.optional().default(0),
  stock: z.coerce.number().int().min(0).max(1_000_000),
  minStock: z.coerce.number().int().min(0).max(1_000_000).default(0),
  status: z.enum(["active", "disabled"]).default("active"),
}).strict();
const productColor = z.object({
  name: z.string().trim().min(1).max(40),
  hex,
  featuredImage: imageRef.optional(),
  images: z.array(imageRef.unwrap()).max(12).optional(),
}).strict();
const productContentBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("banner"), image: imageRef.unwrap() }).strict(),
  z.object({ type: z.literal("imageRow"), images: z.array(imageRef.unwrap()).length(3) }).strict(),
]);

const productBase = {
  name: z.string().trim().min(2).max(160),
  slug: slug.max(180).optional(),
  sku: z.string().trim().max(64).optional(),
  brand: z.string().trim().max(80).optional(),
  shortDescription: z.string().trim().max(300).optional(),
  description: z.string().trim().max(10_000).optional(),
  category: objectId,
  images: z.array(imageRef.unwrap()).max(12).optional(),
  colors: z.array(productColor).max(20).optional(),
  contentBlocks: z.array(productContentBlock).max(30).optional(),
  sizes: z.array(z.string().trim().min(1).max(20)).max(30).optional(),
  variants: z.array(variant).min(1).max(200).optional(),
  // Simple products (single variant): price/mrp/stock instead of `variants`.
  price: money.optional(), mrp: money.optional(), stock: z.coerce.number().int().min(0).max(1_000_000).optional(),
  specs: z.array(z.object({ label: z.string().trim().max(60), value: z.string().trim().max(200) }).strict()).max(30).optional(),
  weightGrams: z.coerce.number().min(0).max(1_000_000).optional(),
  dimensionsCm: z.object({ length: z.number().min(0), width: z.number().min(0), height: z.number().min(0) }).partial().strict().optional(),
  isNewArrival: z.boolean().optional(), isBestseller: z.boolean().optional(), isTrending: z.boolean().optional(), isFeatured: z.boolean().optional(),
  badge: z.enum(BADGES).optional(),
  occasions: z.array(z.string().trim().max(40)).max(10).optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
  lowStockThreshold: z.number().int().min(0).max(100_000).nullable().optional(),
  seo: productSeo.optional(),
};
const productRefine = (p, ctx) => {
  if (p.variants && (p.price !== undefined || p.stock !== undefined)) ctx.addIssue({ code: "custom", path: ["variants"], message: "Send either variants or price/stock, not both." });
  if (p.price !== undefined && p.mrp && p.mrp < p.price) ctx.addIssue({ code: "custom", path: ["mrp"], message: "MRP can't be lower than the price." });
};
export const createProductSchema = z.object(productBase).strict().superRefine((p, ctx) => {
  productRefine(p, ctx);
  if (!p.variants && p.price === undefined) ctx.addIssue({ code: "custom", path: ["price"], message: "Enter a price, or add variants." });
});
export const updateProductSchema = z.object(productBase).partial().strict().superRefine(productRefine);

export const adminProductsQuery = z.object({
  ...pagination,
  q: z.string().trim().max(100).optional(), category: objectId.optional(),
  status: z.enum(PRODUCT_STATUSES).optional(), stock: z.enum(["out", "low", "in"]).optional(),
  flag: z.enum(["new", "bestseller", "trending", "featured"]).optional(),
  sort: z.enum(["newest", "oldest", "name", "price_low", "price_high", "stock_low"]).default("newest"),
});
export const stockAdjustSchema = z.object({
  variantId: objectId,
  delta: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  set: z.number().int().min(0).max(1_000_000).optional(),
  reason: z.enum(MANUAL_STOCK_REASONS).default("adjustment"),
  // Every manual change needs a written reason (kept in the stock history).
  note: z.string({ required_error: "Enter a reason for this stock change." }).trim().min(3, "Enter a reason for this stock change.").max(300),
  // Stock the admin saw when opening the form; the change is refused if it has moved since.
  expectedStock: z.number().int().min(0).optional(),
}).strict().refine((v) => (v.delta === undefined) !== (v.set === undefined), "Send either delta or set.");
export const bulkProductsSchema = z.object({
  ids: z.array(objectId).min(1).max(200),
  action: z.enum(["activate", "disable", "archive", "delete"]),
}).strict();

/* ---------- Public listing ---------- */
export const publicProductsQuery = z.object({
  ...pagination, limit: z.coerce.number().int().min(1).max(60).default(24),
  category: z.string().trim().toLowerCase().regex(/^[a-z0-9/-]+$/).max(200).optional(),
  sub: csv(z.string().max(80)).optional(), cats: csv(z.string().max(80)).optional(),
  sizes: csv(z.string().max(20)).optional(), colors: csv(z.string().max(40)).optional(),
  minPrice: z.coerce.number().min(0).optional(), maxPrice: z.coerce.number().min(0).optional(),
  sale: z.enum(["1", "true"]).transform(() => true).optional(), inStock: z.enum(["1", "true"]).transform(() => true).optional(),
  flag: z.enum(["new", "bestseller", "trending", "featured"]).optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(["featured", "new", "low", "high", "off", "bestselling"]).default("featured"),
  facets: z.enum(["1", "true", "0", "false"]).transform((v) => v === "1" || v === "true").default("1"),
});
export const idsQuery = z.object({ ids: csv(objectId).pipe(z.array(objectId).max(60)) });
