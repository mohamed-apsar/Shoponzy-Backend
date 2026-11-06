import { env } from "../config/env.js";
import { SiteSetting } from "../models/site.js";
import { SECTIONS } from "../validators/siteValidators.js";

/* Defaults = what the live storefront shows today, so an unconfigured site looks unchanged. */
export const DEFAULT_SETTINGS = {
  homeCategories: { categories: [], showAllCategories: true, showNewIn: true, showDeals: true },
  general: {
    websiteName: "Shoponzy", tagline: "Shoes, sunglasses, perfumes, clothing, watches & essentials", websiteUrl: "https://shoponzy.in",
    currency: "INR", language: "English", productsPerPage: 24, gridColumns: 4, breadcrumbs: true, wishlist: true, comparison: false,
  },
  branding: {
    logo: null, footerLogo: null, favicon: null,
    primaryColor: "#FF4D2E", secondaryColor: "#111318", accentColor: "#F5A623", font: "Plus Jakarta Sans",
    browserTitle: "Shoponzy | Shoes, Sunglasses, Perfumes, Clothing & Watches Online",
    metaDescription: "Shop shoes, sunglasses, perfumes, clothing, watches and essentials online at Shoponzy. Free delivery above ₹999, COD and 7-day returns.",
  },
  headerFooter: {
    headerLogo: null, footerLogo: null, announcementVisible: true, stickyHeader: true, searchVisible: true,
    wishlistVisible: true, cartVisible: true, accountVisible: true,
    footerDescription: "Shoes, sunglasses, perfumes, clothing, watches and everyday essentials, delivered across India.",
    contactEmail: "support@shoponzy.in", contactPhone: "+91 90000 00000", address: "Shoponzy, Street, City, Tamil Nadu",
    copyright: "© Shoponzy. Developed by BHive Technologies.", socialIcons: true,
    linkGroups: "About us, Shipping policy, Return & refund policy, Privacy policy, Terms & conditions",
  },
  announcement: {
    messages: ["👟 Step into style! Extra 5% OFF on prepaid orders", "🚚 Free delivery on orders above ₹999", "🔁 7-day easy returns & exchange", "🎁 Use WELCOME10 for 10% off above ₹1,499"],
    url: "", background: "#111318", color: "#FFFFFF", position: "top", startDate: null, endDate: null, enabled: true,
  },
  seo: {
    title: "Shoponzy | Shoes, Sunglasses, Perfumes, Clothing & Watches Online",
    description: "Shop shoes, sunglasses, perfumes, clothing, watches and essentials online at Shoponzy. Free delivery above ₹999, COD and 7-day returns.",
    keywords: "shoes, sunglasses, perfumes, clothing, watches, online shopping India", canonical: "https://shoponzy.in",
    ogTitle: "Shoponzy", ogDescription: "Shoes, sunglasses, perfumes, clothing, watches and essentials.", shareImage: null,
    googleVerification: "", bingVerification: "", baiduVerification: "", yandexVerification: "",
    robotsTxt: "", robotsMeta: "index, follow", sitemapXml: "",
  },
  contact: {
    email: "support@shoponzy.in", phone: "+91 90000 00000", whatsapp: "919000000000", address: "Shoponzy, Street, City, Tamil Nadu",
    hours: "Monday–Saturday, 10:00 AM–7:00 PM IST", instagram: "", facebook: "", youtube: "", pinterest: "", linkedin: "",
  },
  maintenance: {
    enabled: false, heading: "We’ll be right back", message: "We’re making a few improvements. Please check back soon.",
    illustration: null, reopenAt: null, showContact: true,
  },
  commerce: {
    freeShippingAbove: 999, shippingFee: 59, prepaidOffPct: 5, codEnabled: true, codMaxOrderValue: null,
    deliveryText: "Usually delivered in 3–7 working days", returnDays: 7,
  },
  inventory: { lowStockThreshold: env.LOW_STOCK_THRESHOLD },
};

export async function getSection(section) {
  const doc = await SiteSetting.findOne({ key: section }).lean();
  return { ...DEFAULT_SETTINGS[section], ...(doc?.value || {}) };
}

export async function getAllSettings() {
  const docs = await SiteSetting.find({ key: { $in: SECTIONS } }).lean();
  const byKey = Object.fromEntries(docs.map((d) => [d.key, d.value]));
  return Object.fromEntries(SECTIONS.map((s) => [s, { ...DEFAULT_SETTINGS[s], ...(byKey[s] || {}) }]));
}

export async function updateSection(section, patch) {
  const current = await getSection(section);
  const value = { ...current, ...patch };
  await SiteSetting.updateOne({ key: section }, { $set: { value } }, { upsert: true });
  return { value, previous: current };
}

export async function resetSection(section) {
  const previous = await getSection(section);
  await SiteSetting.deleteOne({ key: section });
  return { value: DEFAULT_SETTINGS[section], previous };
}

/* What the storefront may see: everything except internal fields, with maintenance/announcement schedules resolved. */
export function publicSettings(all, now = new Date()) {
  const inWindow = (start, end) => (!start || new Date(start) <= now) && (!end || new Date(end) >= now);
  const a = all.announcement;
  const publicSeo = { ...all.seo };
  delete publicSeo.sitemapXml;
  const { inventory: _inventory, ...visible } = all;
  return {
    ...visible,
    seo: publicSeo,
    announcement: { ...a, active: a.enabled && all.headerFooter.announcementVisible && inWindow(a.startDate, a.endDate) },
  };
}
