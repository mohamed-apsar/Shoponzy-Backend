import { audit } from "../../models/AuditLog.js";
import { Campaign, EmailLog } from "../../models/notification.js";
import { ContactMessage, Faq } from "../../models/site.js";
import * as campaigns from "../../services/campaignService.js";
import * as settings from "../../services/settingsService.js";
import { emailEnabled, supportReplyEmail, trySendMail } from "../../services/emailService.js";
import { AppError } from "../../utils/AppError.js";
import { created, ok, paginate } from "../../utils/respond.js";
import { MAX_EXPORT_ROWS, csvDate, sendCsv } from "../../utils/csv.js";
import { escapeRegex } from "../../validators/common.js";

const actor = (req) => req.auth.user;
const log = (req, action, entity, entityId, meta) => audit(action, { actor: req.auth.user._id, entity, entityId, ip: req.ip, meta });
const view = (doc) => (doc?.toJSON ? doc.toJSON() : doc);

/* ================= FAQ Management ================= */
/* The three FAQs the storefront showed before FAQs were managed here. */
export const DEFAULT_FAQS = [
  { question: "How do I place an order?", answer: "Add items to your bag, check out, and pay online or choose cash on delivery. You get an order ID straight away.", category: "Orders" },
  { question: "Is cash on delivery available?", answer: "Yes, on most PIN codes. Paying online gets you an extra 5% off.", category: "Payments" },
  { question: "How do I find my size?", answer: "Tap “Size guide” on any product page. If you’re between sizes, pick the larger one or ask us on WhatsApp.", category: "Products" },
];

export async function listFaqs(req, res) {
  const { q, status, category } = req.valid.query;
  const filter = {};
  if (status) filter.status = status;
  if (category) filter.category = category;
  if (q) { const rx = new RegExp(escapeRegex(q), "i"); filter.$or = [{ question: rx }, { answer: rx }, { category: rx }]; }
  const [items, categories, counts] = await Promise.all([
    Faq.find(filter).sort({ order: 1, createdAt: 1 }),
    Faq.distinct("category"),
    Faq.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  const c = Object.fromEntries(counts.map((x) => [x._id, x.n]));
  ok(res, items, { total: items.length, categories: categories.sort(), counts: { active: c.active || 0, hidden: c.hidden || 0 } });
}

export async function createFaq(req, res) {
  const last = await Faq.findOne().sort({ order: -1 }).select("order").lean();
  const faq = await Faq.create({ category: "General", ...req.valid.body, order: req.valid.body.order ?? (last ? last.order + 1 : 1) });
  await log(req, "faq.created", "Faq", faq._id, { question: faq.question });
  created(res, faq);
}

export async function updateFaq(req, res) {
  const faq = await Faq.findByIdAndUpdate(req.params.id, { $set: req.valid.body }, { new: true, runValidators: true });
  if (!faq) throw AppError.notFound("FAQ not found.");
  await log(req, "faq.updated", "Faq", faq._id, { fields: Object.keys(req.valid.body) });
  ok(res, faq);
}

export async function deleteFaq(req, res) {
  const faq = await Faq.findByIdAndDelete(req.params.id);
  if (!faq) throw AppError.notFound("FAQ not found.");
  await log(req, "faq.deleted", "Faq", faq._id, { question: faq.question });
  ok(res, { deleted: true });
}

export async function reorderFaqs(req, res) {
  const ids = req.valid.body.ids;
  const rest = (await Faq.find({ _id: { $nin: ids } }).sort({ order: 1, createdAt: 1 }).select("_id").lean()).map((f) => String(f._id));
  await Promise.all([...ids, ...rest].map((id, i) => Faq.updateOne({ _id: id }, { $set: { order: i + 1 } })));
  await log(req, "faq.reordered", "Faq", null, { count: ids.length });
  ok(res, await Faq.find().sort({ order: 1 }));
}

/* Starts the list from what the storefront showed before (only when there are no FAQs yet). */
export async function importDefaultFaqs(req, res) {
  if (await Faq.exists({})) throw AppError.conflict("FAQs already exist.");
  const items = await Faq.insertMany(DEFAULT_FAQS.map((f, i) => ({ ...f, order: i + 1 })));
  await log(req, "faq.imported_defaults", "Faq", null, { count: items.length });
  created(res, items);
}

export async function exportFaqs(req, res) {
  const items = await Faq.find().sort({ order: 1, createdAt: 1 }).lean();
  const rows = [["position", "category", "question", "answer", "status", "updated"]];
  items.forEach((f, i) => rows.push([i + 1, f.category, f.question, f.answer, f.status, csvDate(f.updatedAt)]));
  await log(req, "faq.exported", "Faq", null, { rows: items.length });
  sendCsv(res, `shoponzy-faqs-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}

/* ================= Notifications ================= */
export const notificationSummary = async (_req, res) => ok(res, await campaigns.notificationSummary());

export async function listCampaigns(req, res) {
  const { type, status, q, ...pageQ } = req.valid.query;
  const filter = {};
  if (type) filter.type = type;
  if (status) filter.status = status;
  if (q) { const rx = new RegExp(escapeRegex(q), "i"); filter.$or = [{ title: rx }, { subject: rx }]; }
  const { skip, limit, meta } = paginate(pageQ);
  const [items, total] = await Promise.all([
    Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("createdBy", "name").populate("sentBy", "name"),
    Campaign.countDocuments(filter),
  ]);
  ok(res, items, meta(total));
}

export async function getCampaign(req, res) {
  const c = await Campaign.findById(req.params.id).populate("products", "name slug images minPrice status").populate("createdBy", "name").populate("sentBy", "name");
  if (!c) throw AppError.notFound("Notification not found.");
  ok(res, c);
}

export const createCampaign = async (req, res) => created(res, view(await campaigns.createCampaign(req.valid.body, actor(req))));
export const updateCampaign = async (req, res) => ok(res, view(await campaigns.updateCampaign(req.params.id, req.valid.body, actor(req))));
export async function deleteCampaign(req, res) { await campaigns.deleteCampaign(req.params.id, actor(req)); ok(res, { deleted: true }); }
export const cancelCampaign = async (req, res) => ok(res, view(await campaigns.cancelCampaign(req.params.id, actor(req))));
export const sendTest = async (req, res) => ok(res, view(await campaigns.sendTest(req.params.id, req.valid.body.email, actor(req), campaigns.apiBaseUrl(req))));
export const sendBatch = async (req, res) => ok(res, view(await campaigns.sendNextBatch(req.params.id, actor(req), campaigns.apiBaseUrl(req))));

export async function previewCampaign(req, res) {
  const c = await Campaign.findById(req.params.id);
  if (!c) throw AppError.notFound("Notification not found.");
  const msg = await campaigns.renderCampaign(c, { base: campaigns.apiBaseUrl(req) });
  ok(res, { subject: msg.subject, html: msg.html });
}

export async function getNotificationSettings(_req, res) {
  ok(res, { settings: await settings.getSection("notifications"), emailConfigured: emailEnabled() });
}

export async function updateNotificationSettings(req, res) {
  const { value } = await settings.updateSection("notifications", req.valid.body);
  await log(req, "notifications.settings_updated", "SiteSetting", "notifications", req.valid.body);
  ok(res, { settings: value, emailConfigured: emailEnabled() });
}

export async function emailLog(req, res) {
  const { type, status, q, from, to, ...pageQ } = req.valid.query;
  const filter = {};
  if (type) filter.type = type;
  if (status) filter.status = status;
  if (from || to) filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (q) { const rx = new RegExp(escapeRegex(q), "i"); filter.$or = [{ to: rx }, { subject: rx }, { ref: rx }]; }
  const { skip, limit, meta } = paginate(pageQ);
  const [items, total] = await Promise.all([EmailLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit), EmailLog.countDocuments(filter)]);
  ok(res, items, meta(total));
}

export async function exportCampaigns(req, res) {
  const items = await Campaign.find(req.valid.query.type ? { type: req.valid.query.type } : {}).sort({ createdAt: -1 }).limit(MAX_EXPORT_ROWS).populate("sentBy", "name").lean();
  const rows = [["type", "title", "subject", "status", "recipients", "sent", "failed", "coupon", "offer", "created", "sent_at", "sent_by"]];
  for (const c of items) rows.push([c.type, c.title, c.subject, c.status, c.stats?.total || 0, c.stats?.sent || 0, c.stats?.failed || 0, c.couponCode, c.offerText, csvDate(c.createdAt), csvDate(c.sentAt), c.sentBy?.name]);
  await log(req, "campaigns.exported", "Campaign", null, { rows: items.length });
  sendCsv(res, `shoponzy-notifications-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}

export async function exportEmailLog(req, res) {
  const { type, status, from, to } = req.valid.query;
  const filter = {};
  if (type) filter.type = type;
  if (status) filter.status = status;
  if (from || to) filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const items = await EmailLog.find(filter).sort({ createdAt: -1 }).limit(MAX_EXPORT_ROWS).lean();
  const rows = [["date_time", "to", "subject", "type", "status", "error", "reference"]];
  for (const e of items) rows.push([csvDate(e.createdAt), e.to, e.subject, e.type, e.status, e.error, e.ref]);
  await log(req, "email_log.exported", "EmailLog", null, { rows: items.length });
  sendCsv(res, `shoponzy-email-log-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}

/* ================= Help & Support ================= */
function supportFilter({ q, status, topic, from, to }) {
  const filter = {};
  if (status) filter.status = status;
  if (topic) filter.topic = topic;
  if (from || to) filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (q) { const rx = new RegExp(escapeRegex(q), "i"); filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { orderNumber: rx }, { subject: rx }, { message: rx }]; }
  return filter;
}

export async function listSupport(req, res) {
  const filter = supportFilter(req.valid.query);
  const { skip, limit, meta } = paginate(req.valid.query);
  const [items, total, counts] = await Promise.all([
    ContactMessage.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).select("-notes"),
    ContactMessage.countDocuments(filter),
    ContactMessage.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  ok(res, items, { ...meta(total), counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
}

/* Opening a new message marks it as open ("read"). */
export async function getSupport(req, res) {
  const msg = await ContactMessage.findById(req.params.id).populate("replies.by", "name").populate("notes.by", "name").populate("user", "name email");
  if (!msg) throw AppError.notFound("Message not found.");
  if (msg.status === "new") { msg.status = "read"; await msg.save(); }
  ok(res, msg);
}

export async function replySupport(req, res) {
  const { message, sendEmail, close } = req.valid.body;
  const msg = await ContactMessage.findById(req.params.id);
  if (!msg) throw AppError.notFound("Message not found.");
  const reply = { message, by: req.auth.user._id, at: new Date(), emailed: false };
  if (sendEmail) {
    if (!msg.email) throw AppError.badRequest("This customer didn't leave an email address. Call them on the phone number instead, and record what you discussed with “Save without emailing”.");
    if (!emailEnabled()) throw new AppError(503, "EMAIL_NOT_CONFIGURED", "Email isn't set up on the server, so the reply can't be emailed. Save it without emailing and contact the customer by phone.");
    const result = await trySendMail({ to: msg.email, ...supportReplyEmail(msg, message), type: "support_reply", ref: String(msg._id) });
    if (!result.sent) throw new AppError(502, "EMAIL_FAILED", `The reply couldn't be emailed${result.error ? `: ${result.error}` : ""}. Nothing was saved; try again.`);
    reply.emailed = true;
  }
  msg.replies.push(reply);
  msg.lastReplyAt = reply.at;
  msg.status = close ? "closed" : "replied";
  await msg.save();
  await log(req, "support.replied", "ContactMessage", msg._id, { emailed: reply.emailed, closed: close });
  ok(res, await ContactMessage.findById(msg._id).populate("replies.by", "name").populate("notes.by", "name"));
}

export async function noteSupport(req, res) {
  const msg = await ContactMessage.findByIdAndUpdate(req.params.id, { $push: { notes: { note: req.valid.body.note, by: req.auth.user._id, at: new Date() } } }, { new: true });
  if (!msg) throw AppError.notFound("Message not found.");
  await log(req, "support.note_added", "ContactMessage", msg._id);
  ok(res, await ContactMessage.findById(msg._id).populate("replies.by", "name").populate("notes.by", "name"));
}

export async function setSupportStatus(req, res) {
  const msg = await ContactMessage.findByIdAndUpdate(req.params.id, { $set: { status: req.valid.body.status } }, { new: true });
  if (!msg) throw AppError.notFound("Message not found.");
  await log(req, "support.status_changed", "ContactMessage", msg._id, { status: msg.status });
  ok(res, await ContactMessage.findById(msg._id).populate("replies.by", "name").populate("notes.by", "name"));
}

export async function exportSupport(req, res) {
  const items = await ContactMessage.find(supportFilter(req.valid.query)).sort({ createdAt: -1 }).limit(MAX_EXPORT_ROWS).lean();
  const rows = [["received", "name", "phone", "email", "topic", "order_id", "message", "status", "replies", "last_reply"]];
  for (const m of items) rows.push([csvDate(m.createdAt), m.name, m.phone, m.email, m.topic, m.orderNumber, m.message, m.status === "read" ? "open" : m.status, m.replies?.length || 0, csvDate(m.lastReplyAt)]);
  await log(req, "support.exported", "ContactMessage", null, { rows: items.length });
  sendCsv(res, `shoponzy-support-requests-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}
