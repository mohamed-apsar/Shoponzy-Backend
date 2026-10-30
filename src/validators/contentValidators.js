import { z } from "zod";
import { email, name, objectId, phone } from "./common.js";
import { imageRef, link } from "./siteValidators.js";
import { SECTION_SOURCES } from "../models/site.js";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
// "" and null clear the date. They must be matched before coerce.date(), which turns null into 1970-01-01.
const date = z.union([z.literal(""), z.null(), z.coerce.date()]).transform((v) => v || null);
const schedule = (s) => s.refine((v) => !v.startsAt || !v.endsAt || v.endsAt >= v.startsAt, { message: "End date must be after the start date.", path: ["endsAt"] });
// Only safe CSS gradient/colour syntax for banner backgrounds.
const background = z.string().trim().max(200).regex(/^(linear-gradient\([#a-zA-Z0-9.,%\s()-]+\)|#[0-9a-fA-F]{6})?$/, "Use a hex colour or a linear-gradient().");

const bannerBase = z.object({
  title: z.string().trim().min(1).max(100), subtitle: z.string().trim().max(200).optional(), kicker: z.string().trim().max(60).optional(),
  image: imageRef.optional(), mobileImage: imageRef.optional(), background: background.optional(),
  art: z.object({ kind: z.string().max(20), color: hex, category: z.string().max(40) }).strict().optional(),
  buttonText: z.string().trim().max(40).optional(), url: link.optional(),
  placement: z.enum(["hero", "secondary", "strip"]).optional(), order: z.coerce.number().int().min(0).max(1000).optional(),
  startsAt: date.optional(), endsAt: date.optional(), status: z.enum(["active", "inactive"]).optional(),
}).strict();
export const createBannerSchema = schedule(bannerBase);
export const updateBannerSchema = schedule(bannerBase.partial());

const sectionBase = z.object({
  title: z.string().trim().min(1).max(80), subtitle: z.string().trim().max(160).optional(),
  type: z.enum(["products", "categories"]).optional(), source: z.enum(SECTION_SOURCES).optional(),
  category: objectId.nullable().optional(), products: z.array(objectId).max(24).optional(), categories: z.array(objectId).max(24).optional(),
  layout: z.enum(["rail", "grid"]).optional(), count: z.coerce.number().int().min(1).max(24).optional(),
  order: z.coerce.number().int().min(0).max(1000).optional(), buttonText: z.string().trim().max(40).optional(), url: link.optional(), active: z.boolean().optional(),
}).strict();
export const createSectionSchema = sectionBase.refine((s) => s.source !== "category" || s.category, { message: "Choose a category.", path: ["category"] });
export const updateSectionSchema = sectionBase.partial();
export const reorderSchema = z.object({ ids: z.array(objectId).min(1).max(100) }).strict();

const popupBase = z.object({
  title: z.string().trim().min(1).max(100), description: z.string().trim().max(500).optional(), image: imageRef.optional(),
  buttonText: z.string().trim().max(40).optional(), url: link.optional(),
  trigger: z.enum(["delay", "exit", "scroll", "immediate"]).optional(), delaySeconds: z.coerce.number().int().min(0).max(120).optional(),
  frequency: z.enum(["session", "day", "week", "always"]).optional(),
  startsAt: date.optional(), endsAt: date.optional(), status: z.enum(["active", "inactive"]).optional(),
}).strict();
export const createPopupSchema = schedule(popupBase);
export const updatePopupSchema = schedule(popupBase.partial());

const pageBase = z.object({
  title: z.string().trim().min(1).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  description: z.string().trim().max(300).optional(), content: z.string().max(50_000).optional(),
  seo: z.object({ title: z.string().trim().max(70).optional(), description: z.string().trim().max(160).optional() }).strict().optional(),
  status: z.enum(["published", "draft"]).optional(),
}).strict();
export const createPageSchema = pageBase;
export const updatePageSchema = pageBase.partial();

/* ---------- Public forms ---------- */
export const contactSchema = z.object({
  name, phone, email: z.union([email, z.literal("")]).optional().transform((v) => v || undefined),
  topic: z.enum(["Order question", "Return / exchange", "Product question", "Something else"]).default("Something else"),
  orderNumber: z.union([z.string().trim().toUpperCase().regex(/^SZ\d{6,9}$/, "Check the order ID."), z.literal("")]).optional().transform((v) => v || undefined),
  message: z.string().trim().min(5, "Tell us a little more.").max(3000),
}).strict();
export const newsletterSchema = z.object({ email, source: z.string().trim().max(40).optional() }).strict();
export const contactStatusSchema = z.object({ status: z.enum(["new", "read", "closed"]) }).strict();
