import { env } from "../config/env.js";
import { Page, ContactMessage, NewsletterSubscriber } from "../models/site.js";
import { Product } from "../models/Product.js";
import { Category } from "../models/Category.js";
import { getAllSettings, publicSettings } from "../services/settingsService.js";
import { activeBanners, activePopups, resolvedSections } from "../services/homepageService.js";
import { hiddenCategoryIds } from "../services/categoryService.js";
import { AppError } from "../utils/AppError.js";
import { created, ok } from "../utils/respond.js";

export const settings = async (_req, res) => {
  res.set("Cache-Control", "public, max-age=60");
  ok(res, publicSettings(await getAllSettings()));
};

export async function homepage(_req, res) {
  const [banners, sections] = await Promise.all([activeBanners(), resolvedSections()]);
  ok(res, { banners, sections });
}

export const banners = async (req, res) => ok(res, await activeBanners(req.query.placement ? String(req.query.placement) : undefined));
export const popups = async (_req, res) => ok(res, await activePopups());

export async function pages(_req, res) {
  ok(res, await Page.find({ status: "published" }).select("title slug description updatedAt").sort({ title: 1 }).lean()
    .then((list) => list.map(({ _id, ...p }) => ({ id: String(_id), ...p }))));
}

export async function pageBySlug(req, res) {
  const page = await Page.findOne({ slug: String(req.params.slug).toLowerCase(), status: "published" });
  if (!page) throw AppError.notFound("Page not found.");
  ok(res, page);
}

export async function contact(req, res) {
  const msg = await ContactMessage.create({ ...req.valid.body, user: req.auth?.user._id });
  created(res, { id: String(msg._id), received: true });
}

export async function newsletter(req, res) {
  const { email, source } = req.valid.body;
  await NewsletterSubscriber.updateOne({ email }, { $set: { status: "subscribed" }, $setOnInsert: { source: source || "footer" } }, { upsert: true });
  ok(res, { subscribed: true });
}

/* sitemap.xml for the storefront domain (serve at https://shoponzy.in/sitemap.xml via the web server proxy). */
export async function sitemap(_req, res) {
  const base = env.CLIENT_URL.replace(/\/$/, "");
  const hidden = await hiddenCategoryIds();
  const [cats, products, pagesList] = await Promise.all([
    Category.find({ level: 1, status: "enabled", _id: { $nin: hidden } }).select("slug updatedAt").lean(),
    Product.find({ status: "active", categoryPath: { $nin: hidden } }).select("slug updatedAt").lean(),
    Page.find({ status: "published" }).select("slug updatedAt").lean(),
  ]);
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const url = (loc, lastmod) => `<url><loc>${esc(base + loc)}</loc>${lastmod ? `<lastmod>${new Date(lastmod).toISOString().slice(0, 10)}</lastmod>` : ""}</url>`;
  const body = [
    url("/"), url("/products"),
    ...cats.map((c) => url(`/categories/${c.slug}`, c.updatedAt)),
    ...products.map((p) => url(`/products/${p.slug}`, p.updatedAt)),
    ...pagesList.map((p) => url(`/pages/${p.slug}`, p.updatedAt)),
  ].join("");
  res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`);
}

export function robots(_req, res) {
  const base = env.CLIENT_URL.replace(/\/$/, "");
  res.type("text/plain").send(`User-agent: *\nDisallow: /cart\nDisallow: /checkout\nDisallow: /account\nDisallow: /reset-password\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`);
}
