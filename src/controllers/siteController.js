import { env } from "../config/env.js";
import { Page, ContactMessage, NewsletterSubscriber, NotFoundLog } from "../models/site.js";
import { Faq } from "../models/site.js";
import { supportAckEmail, trySendMail } from "../services/emailService.js";
import { getSection } from "../services/settingsService.js";
import { verifyUnsubscribe } from "../services/campaignService.js";
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
  // Automatic "we've received your message" email (Notifications → Email Notifications). Fire-and-forget.
  if (msg.email) {
    Promise.all([getSection("notifications"), getSection("contact")]).then(([n, contactInfo]) => {
      if (n.supportAutoReply === false) return;
      return trySendMail({ to: msg.email, ...supportAckEmail(msg, contactInfo), type: "support_ack", ref: String(msg._id) });
    }).catch(() => {});
  }
  created(res, { id: String(msg._id), received: true });
}

/* ---------- FAQs (public, active only) ---------- */
export async function faqs(_req, res) {
  const items = await Faq.find({ status: "active" }).sort({ order: 1, createdAt: 1 }).select("question answer category").lean();
  ok(res, items.map(({ _id, question, answer, category }) => ({ id: String(_id), question, answer, category })));
}

/* ---------- Newsletter unsubscribe (signed link from promotional emails) ---------- */
const page = (res, status, title, body) => res.status(status)
  .set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
  .type("html")
  .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;background:#f4f5fa;color:#1f2940;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#fff;padding:32px;border-radius:14px;max-width:420px;text-align:center;box-shadow:0 8px 30px #1f294014}h1{font-size:22px;margin:0 0 10px}button{background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:15px;font-weight:700;cursor:pointer}</style></head>
<body><main><h1>${title}</h1>${body}</main></body></html>`);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

export function unsubscribePage(req, res) {
  const e = String(req.query.e || ""), t = String(req.query.t || "");
  if (!verifyUnsubscribe(e, t)) return page(res, 400, "Link not valid", "<p>This unsubscribe link is incomplete or has been changed. Use the link from the latest email.</p>");
  page(res, 200, "Unsubscribe from Shoponzy emails?", `<p>${esc(e)} will stop receiving offers and announcements. Order and account emails are not affected.</p>
<form method="post" action="?e=${encodeURIComponent(e)}&amp;t=${encodeURIComponent(t)}"><button type="submit">Unsubscribe</button></form>`);
}

export async function unsubscribe(req, res) {
  const e = String(req.query.e || req.body?.e || ""), t = String(req.query.t || req.body?.t || "");
  if (!verifyUnsubscribe(e, t)) return page(res, 400, "Link not valid", "<p>This unsubscribe link is incomplete or has been changed.</p>");
  await NewsletterSubscriber.updateOne({ email: e.toLowerCase() }, { $set: { status: "unsubscribed" } });
  page(res, 200, "You're unsubscribed", `<p>${esc(e)} won't receive Shoponzy offers or announcements any more.</p>`);
}

export async function newsletter(req, res) {
  const { email, source } = req.valid.body;
  await NewsletterSubscriber.updateOne({ email }, { $set: { status: "subscribed" }, $setOnInsert: { source: source || "footer" } }, { upsert: true });
  ok(res, { subscribed: true });
}

export async function trackNotFound(req, res) {
  const { path } = req.valid.body;
  const log = await NotFoundLog.findOneAndUpdate(
    { path },
    { $setOnInsert: { path, redirectTo: "" }, $inc: { hits: 1 }, $set: { lastHitAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: false },
  ).select("redirectTo").lean();
  ok(res, { redirectTo: log.redirectTo });
}

/* sitemap.xml for the storefront domain (serve at https://shoponzy.in/sitemap.xml via the web server proxy). */
export async function sitemap(req, res) {
  const saved = req.query.refresh === "true" ? "" : (await getAllSettings()).seo.sitemapXml;
  if (saved) {
    res.type("application/xml").send(saved);
    return;
  }
  res.type("application/xml").send(await generateSitemap());
}

export async function generateSitemap() {
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
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`;
}

export async function robots(_req, res) {
  const saved = (await getAllSettings()).seo.robotsTxt;
  if (saved) {
    res.type("text/plain").send(saved.endsWith("\n") ? saved : `${saved}\n`);
    return;
  }
  const base = env.CLIENT_URL.replace(/\/$/, "");
  res.type("text/plain").send(`User-agent: *\nDisallow: /cart\nDisallow: /checkout\nDisallow: /account\nDisallow: /reset-password\nAllow: /\n\nSitemap: ${base}/sitemap.xml\n`);
}
