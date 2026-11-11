import { z } from "zod";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a 6-digit hex colour.");
// Internal paths ("/categories/shoes") or absolute http(s) URLs only — never javascript: etc.
export const link = z.string().trim().max(500).refine((v) => v === "" || /^\/(?!\/)/.test(v) || /^https?:\/\//i.test(v), "Use a /path or an http(s):// URL.");
const optionalUrl = z.string().trim().max(500).refine((v) => v === "" || /^https?:\/\//i.test(v), "Use an http(s):// URL.");
export const robotsDirectivesSchema = z.string().trim().max(300).refine(
  (value) => value.split(",").every((directive) => /^(?:index|noindex|follow|nofollow|noarchive|noimageindex|nosnippet|max-snippet:-?\d+|max-video-preview:-?\d+|max-image-preview:(?:large|standard|none))$/.test(directive.trim().toLowerCase())),
  "Use supported robots meta directives.",
);
// An image previously uploaded via POST /admin/uploads (checked against the upload registry by the service).
// Extra keys (width, bytes… from the upload response) are dropped, so the upload result can be passed straight back.
export const imageRef = z.object({ url: z.string().url().max(1000), publicId: z.string().max(300).nullable().optional(), alt: z.string().max(200).optional() }).nullable();
const phoneText = z.string().trim().max(30);
const text = (max) => z.string().trim().max(max);
// "" and null clear the date. They must be matched before coerce.date(), which turns null into 1970-01-01.
const date = z.union([z.literal(""), z.null(), z.coerce.date()]).transform((v) => (v ? v : null));
export const sitemapXmlSchema = z.string().trim().max(8_000_000).refine(
  (value) => !value || (/^(?:<\?xml\b[\s\S]*?\?>\s*)?<(urlset|sitemapindex)\b/i.test(value) && !/<!DOCTYPE|<!ENTITY/i.test(value)),
  "Upload a valid sitemap XML file without a DTD or entity declarations.",
);

export const SETTINGS_SCHEMAS = {
  homeCategories: z.object({
    categories: z.array(z.string().trim().min(1).max(80)).max(30),
    showAllCategories: z.boolean(), showNewIn: z.boolean(), showDeals: z.boolean(),
  }).strict(),
  general: z.object({
    websiteName: text(60).min(1), tagline: text(120), websiteUrl: optionalUrl,
    taxRate: z.number().min(0).max(100),
    currency: z.enum(["INR"]), language: z.enum(["English"]),
    productsPerPage: z.coerce.number().int().min(4).max(96), gridColumns: z.coerce.number().int().min(2).max(6),
    breadcrumbs: z.boolean(), wishlist: z.boolean(), comparison: z.boolean(),
  }).strict(),
  branding: z.object({
    logo: imageRef, footerLogo: imageRef, favicon: imageRef,
    primaryColor: hex, secondaryColor: hex, accentColor: hex,
    font: z.enum(["Plus Jakarta Sans", "Inter", "System UI", "Roboto", "Lato", "Poppins"]),
    browserTitle: text(70), metaDescription: text(160),
  }).strict(),
  headerFooter: z.object({
    headerLogo: imageRef, footerLogo: imageRef,
    announcementVisible: z.boolean(), stickyHeader: z.boolean(), searchVisible: z.boolean(),
    wishlistVisible: z.boolean(), cartVisible: z.boolean(), accountVisible: z.boolean(),
    footerDescription: text(300), contactEmail: z.union([z.string().email(), z.literal("")]), contactPhone: phoneText,
    address: text(300), copyright: text(160), socialIcons: z.boolean(), linkGroups: text(500),
  }).strict(),
  announcement: z.object({
    messages: z.array(text(120).min(1)).min(1).max(8), url: link,
    background: hex, color: hex, position: z.enum(["top", "below-header"]),
    startDate: date, endDate: date, enabled: z.boolean(),
  }).strict(),
  seo: z.object({
    title: text(70), description: text(160), keywords: text(300), canonical: optionalUrl,
    ogTitle: text(90), ogDescription: text(200), shareImage: imageRef,
    googleVerification: text(300), bingVerification: text(300), baiduVerification: text(300), yandexVerification: text(300),
    robotsTxt: z.string().trim().max(10_000), robotsMeta: robotsDirectivesSchema,
    sitemapXml: sitemapXmlSchema,
  }).strict(),
  contact: z.object({
    email: z.union([z.string().email(), z.literal("")]), phone: phoneText,
    whatsapp: z.string().trim().regex(/^\d{10,15}$|^$/, "Digits only, with country code (e.g. 919876543210)."),
    address: text(300), hours: text(120),
    instagram: optionalUrl, facebook: optionalUrl, youtube: optionalUrl, pinterest: optionalUrl, linkedin: optionalUrl,
  }).strict(),
  maintenance: z.object({
    enabled: z.boolean(), heading: text(100), message: text(500), illustration: imageRef,
    reopenAt: date, showContact: z.boolean(),
  }).strict(),
  commerce: z.object({
    freeShippingAbove: z.number().min(0).max(1_000_000), shippingFee: z.number().min(0).max(10_000),
    prepaidOffPct: z.number().min(0).max(50), codEnabled: z.boolean(),
    codMaxOrderValue: z.number().min(0).max(1_000_000).nullable(),
    deliveryText: text(120), returnDays: z.number().int().min(0).max(60),
  }).strict(),
  // Admin-only (not sent to the storefront): stock alert level used by Inventory Management.
  inventory: z.object({
    lowStockThreshold: z.number().int().min(0).max(100_000),
  }).strict(),
  shipping: z.object({
    states: z.array(z.object({
      name: text(80).min(1), enabled: z.boolean(),
      districts: z.array(z.object({ name: text(80).min(1), enabled: z.boolean() }).strict()).max(100),
    }).strict()).max(40),
    pincodes: z.array(z.object({
      code: z.string().regex(/^\d{6}$/), state: text(80).min(1), district: text(80).min(1),
      price: z.number().min(0).max(10_000), enabled: z.boolean(),
    }).strict()).max(20_000),
  }).strict(),
};

export const SECTIONS = Object.keys(SETTINGS_SCHEMAS);
// Partial updates: admins can save one field at a time.
export const settingsPatchSchema = (section) => SETTINGS_SCHEMAS[section].partial();
