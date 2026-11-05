import { audit, AuditLog } from "../../models/AuditLog.js";
import { HomepageSection, NewsletterSubscriber, NotFoundLog } from "../../models/site.js";
import { Coupon } from "../../models/commerce.js";
import * as settings from "../../services/settingsService.js";
import { dashboard as buildDashboard } from "../../services/dashboardService.js";
import { imageIds, releaseImages, resolveImageKeeping, uploadImage } from "../../services/uploadService.js";
import { SECTIONS, settingsPatchSchema, sitemapXmlSchema } from "../../validators/siteValidators.js";
import { AppError } from "../../utils/AppError.js";
import { created, ok, paginate } from "../../utils/respond.js";
import { escapeRegex } from "../../validators/common.js";
import { generateSitemap } from "../siteController.js";

/* ---------- Dashboard ---------- */
export async function dashboard(req, res) {
  const days = [7, 30, 90, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  ok(res, await buildDashboard({ days }));
}

/* ---------- Manage Site settings ---------- */
const IMAGE_KEYS = ["logo", "footerLogo", "favicon", "headerLogo", "shareImage", "illustration"];

export const allSettings = async (_req, res) => ok(res, await settings.getAllSettings());

export async function updateSettings(req, res) {
  const section = req.params.section;
  if (!SECTIONS.includes(section)) throw AppError.notFound("Unknown settings section.");
  const patch = settingsPatchSchema(section).parse(req.body);
  const current = await settings.getSection(section);
  for (const key of IMAGE_KEYS) if (patch[key] !== undefined) patch[key] = await resolveImageKeeping(patch[key], current[key]);
  const { value, previous } = await settings.updateSection(section, patch);
  await audit("settings.updated", { actor: req.auth.user._id, entity: "SiteSetting", entityId: section, ip: req.ip, meta: { fields: Object.keys(patch) } });
  await releaseImages(imageIds(...IMAGE_KEYS.map((k) => previous[k])).filter((id) => !imageIds(...IMAGE_KEYS.map((k) => value[k])).includes(id)));
  ok(res, value);
}

export async function resetSettings(req, res) {
  const section = req.params.section;
  if (!SECTIONS.includes(section)) throw AppError.notFound("Unknown settings section.");
  const { value, previous } = await settings.resetSection(section);
  await audit("settings.reset", { actor: req.auth.user._id, entity: "SiteSetting", entityId: section, ip: req.ip });
  await releaseImages(imageIds(...IMAGE_KEYS.map((k) => previous[k])));
  ok(res, value);
}

export async function seo404Logs(req, res) {
  const { limit, skip, meta } = paginate(req.valid.query);
  const filter = req.valid.query.q ? { path: new RegExp(escapeRegex(req.valid.query.q), "i") } : {};
  const [items, total] = await Promise.all([
    NotFoundLog.find(filter).sort({ hits: -1, lastHitAt: -1 }).skip(skip).limit(limit).lean(),
    NotFoundLog.countDocuments(filter),
  ]);
  ok(res, items.map(({ _id, ...item }) => ({ id: String(_id), ...item })), meta(total));
}

export async function updateSeo404Redirect(req, res) {
  const item = await NotFoundLog.findByIdAndUpdate(req.params.id, { $set: req.valid.body }, { new: true, runValidators: true });
  if (!item) throw AppError.notFound("404 log not found.");
  await audit("seo.404.redirect.updated", { actor: req.auth.user._id, entity: "NotFoundLog", entityId: String(item._id), ip: req.ip });
  const { _id, ...data } = item.toObject();
  ok(res, { id: String(_id), ...data });
}

export async function deleteSeo404Log(req, res) {
  const item = await NotFoundLog.findByIdAndDelete(req.params.id);
  if (!item) throw AppError.notFound("404 log not found.");
  await audit("seo.404.deleted", { actor: req.auth.user._id, entity: "NotFoundLog", entityId: String(item._id), ip: req.ip });
  ok(res, { deleted: true });
}

export async function generateSeoSitemap(req, res) {
  const sitemapXml = await generateSitemap();
  await settings.updateSection("seo", { sitemapXml: "" });
  await audit("seo.sitemap.generated", { actor: req.auth.user._id, entity: "SiteSetting", entityId: "seo", ip: req.ip });
  ok(res, { sitemapXml, generatedAt: new Date().toISOString() });
}

export async function uploadSeoSitemap(req, res) {
  if (!req.file) throw AppError.badRequest("Choose an XML sitemap file to upload.");
  let sitemapXml;
  try {
    sitemapXml = new TextDecoder("utf-8", { fatal: true }).decode(req.file.buffer);
  } catch {
    throw AppError.badRequest("The sitemap must be a valid UTF-8 XML file.");
  }
  sitemapXml = sitemapXmlSchema.parse(sitemapXml);
  const { value, previous } = await settings.updateSection("seo", { sitemapXml });
  await audit("seo.sitemap.uploaded", { actor: req.auth.user._id, entity: "SiteSetting", entityId: "seo", ip: req.ip });
  ok(res, { sitemapXml: value.sitemapXml, previousSitemap: Boolean(previous.sitemapXml) });
}

/* ---------- Homepage section ordering ---------- */
/* The ids sent come first, in that order; any sections not sent keep their relative order after them. */
export async function reorderSections(req, res) {
  const ids = req.valid.body.ids;
  const rest = (await HomepageSection.find({ _id: { $nin: ids } }).sort({ order: 1, createdAt: 1 }).select("_id").lean()).map((s) => String(s._id));
  await Promise.all([...ids, ...rest].map((id, i) => HomepageSection.updateOne({ _id: id }, { $set: { order: i + 1 } })));
  ok(res, await HomepageSection.find().sort({ order: 1 }));
}

/* ---------- Uploads ---------- */
export async function upload(req, res) {
  if (!req.file) throw AppError.badRequest("Choose an image to upload (form field \"file\").");
  const up = await uploadImage(req.file, String(req.body.kind || ""), req.auth.user);
  await audit("upload.created", { actor: req.auth.user._id, entity: "Upload", entityId: up.publicId, ip: req.ip, meta: { kind: up.kind, bytes: up.bytes } });
  created(res, { url: up.url, publicId: up.publicId, width: up.width, height: up.height, bytes: up.bytes, format: up.format });
}

/* Discards an upload that was never attached (e.g. a cancelled form). Referenced images are kept. */
export async function discardUpload(req, res) {
  await releaseImages([String(req.params.publicId)]);
  ok(res, { discarded: true });
}

/* ---------- Coupons: code must stay unique ---------- */
export async function couponGuard(req, _res, next) {
  if (req.valid?.body?.code) {
    const clash = await Coupon.exists({ code: req.valid.body.code, ...(req.params.id ? { _id: { $ne: req.params.id } } : {}) });
    if (clash) throw AppError.conflict("A coupon with this code already exists.");
  }
  next();
}

/* ---------- Newsletter & audit log ---------- */
export async function newsletterList(req, res) {
  const { skip, limit, meta } = paginate(req.query);
  const filter = req.query.q ? { email: new RegExp(escapeRegex(String(req.query.q)), "i") } : {};
  const [items, total] = await Promise.all([NewsletterSubscriber.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit), NewsletterSubscriber.countDocuments(filter)]);
  ok(res, items, meta(total));
}

export async function newsletterExport(_req, res) {
  const subs = await NewsletterSubscriber.find({ status: "subscribed" }).sort({ createdAt: 1 }).lean();
  res.type("text/csv").attachment("newsletter-subscribers.csv").send(["email,source,subscribed_at", ...subs.map((s) => `${s.email},${s.source},${s.createdAt.toISOString()}`)].join("\n"));
}

export async function auditLogs(req, res) {
  const { skip, limit, meta } = paginate(req.query);
  const filter = req.query.action ? { action: String(req.query.action).slice(0, 60) } : {};
  const [items, total] = await Promise.all([AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("actor", "name email"), AuditLog.countDocuments(filter)]);
  ok(res, items, meta(total));
}
