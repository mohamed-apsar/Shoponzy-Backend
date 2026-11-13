import mongoose from "mongoose";
import { toJSONPlugin } from "./plugins.js";
import { imageSchema } from "./shared.js";

const { Mixed } = mongoose.Schema.Types;

/* ---------- Site settings: one document per Manage Site section (key = section) ---------- */
const siteSettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: Mixed, default: {} },
}, { timestamps: true, minimize: false });
export const SiteSetting = mongoose.model("SiteSetting", siteSettingSchema);

const scheduled = {
  startsAt: { type: Date, default: null },
  endsAt: { type: Date, default: null },
};

/* ---------- Homepage banners ---------- */
const bannerSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 100 },
  subtitle: { type: String, trim: true, maxlength: 200, default: "" },
  kicker: { type: String, trim: true, maxlength: 60, default: "" },
  image: { type: imageSchema, default: null },
  mobileImage: { type: imageSchema, default: null },
  // Used when no image is uploaded: gradient background + product illustration, as on the original site.
  background: { type: String, maxlength: 200, default: "" },
  art: { kind: String, color: String, category: String },
  buttonText: { type: String, maxlength: 40, default: "" },
  url: { type: String, maxlength: 500, default: "" },
  placement: { type: String, enum: ["hero", "secondary", "strip"], default: "hero" },
  order: { type: Number, default: 1 },
  ...scheduled,
  status: { type: String, enum: ["active", "inactive"], default: "active" },
}, { timestamps: true });
bannerSchema.index({ placement: 1, status: 1, order: 1 });
toJSONPlugin(bannerSchema);
export const Banner = mongoose.model("Banner", bannerSchema);

/* ---------- Homepage sections (product rails / category blocks) ---------- */
export const SECTION_SOURCES = ["new", "bestseller", "trending", "deals", "featured", "category", "manual", "categories"];
const homepageSectionSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 80 },
  subtitle: { type: String, trim: true, maxlength: 160, default: "" },
  type: { type: String, enum: ["products", "categories"], default: "products" },
  source: { type: String, enum: SECTION_SOURCES, default: "new" },
  category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", default: null },
  products: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],
  categories: [{ type: mongoose.Schema.Types.ObjectId, ref: "Category" }],
  layout: { type: String, enum: ["rail", "grid"], default: "rail" },
  count: { type: Number, min: 1, max: 24, default: 10 },
  order: { type: Number, default: 1 },
  buttonText: { type: String, maxlength: 40, default: "View all" },
  url: { type: String, maxlength: 500, default: "" },
  active: { type: Boolean, default: true },
}, { timestamps: true });
toJSONPlugin(homepageSectionSchema);
export const HomepageSection = mongoose.model("HomepageSection", homepageSectionSchema);

/* ---------- Promotional popups ---------- */
const popupSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 100 },
  description: { type: String, maxlength: 500, default: "" },
  image: { type: imageSchema, default: null },
  buttonText: { type: String, maxlength: 40, default: "" },
  url: { type: String, maxlength: 500, default: "" },
  trigger: { type: String, enum: ["delay", "exit", "scroll", "immediate"], default: "delay" },
  delaySeconds: { type: Number, min: 0, max: 120, default: 5 },
  frequency: { type: String, enum: ["session", "day", "week", "always"], default: "session" },
  ...scheduled,
  status: { type: String, enum: ["active", "inactive"], default: "active" },
}, { timestamps: true });
toJSONPlugin(popupSchema);
export const Popup = mongoose.model("Popup", popupSchema);

/* ---------- Pages & policies ---------- */
const pageSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  slug: { type: String, required: true, unique: true, lowercase: true, match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ },
  description: { type: String, maxlength: 300, default: "" },
  // Plain text with light Markdown (headings, lists, links). Rendered escaped by the storefront.
  content: { type: String, maxlength: 50_000, default: "" },
  seo: {
    title: { type: String, maxlength: 70, default: "" },
    description: { type: String, maxlength: 160, default: "" },
    robots: { type: String, enum: ["index, follow", "noindex, follow", "index, nofollow", "noindex, nofollow"], default: "index, follow" },
  },
  status: { type: String, enum: ["published", "draft"], default: "draft" },
}, { timestamps: true });
toJSONPlugin(pageSchema);
export const Page = mongoose.model("Page", pageSchema);

/* ---------- Storefront not-found tracking ---------- */
const notFoundLogSchema = new mongoose.Schema({
  path: { type: String, required: true, maxlength: 500 },
  hits: { type: Number, default: 1, min: 1 },
  lastHitAt: { type: Date, default: Date.now },
  redirectTo: { type: String, maxlength: 500, default: "" },
}, { timestamps: true });
notFoundLogSchema.index({ path: 1 }, { unique: true });
notFoundLogSchema.index({ hits: -1, lastHitAt: -1 });
toJSONPlugin(notFoundLogSchema);
export const NotFoundLog = mongoose.model("NotFoundLog", notFoundLogSchema);

/* ---------- Contact messages (Help & Support) & newsletter ---------- */
export const CONTACT_STATUSES = ["new", "read", "replied", "closed"];
const contactMessageSchema = new mongoose.Schema({
  name: { type: String, required: true, maxlength: 100 },
  phone: { type: String, required: true },
  email: String,
  kind: { type: String, enum: ["contact", "ticket"], default: "contact", index: true },
  subject: { type: String, maxlength: 120 },
  type: { type: String, maxlength: 60 },
  priority: { type: String, enum: ["low", "medium", "high"] },
  attachment: { url: String, publicId: String, filename: String },
  topic: { type: String, maxlength: 60 },
  orderNumber: { type: String, maxlength: 20 },
  message: { type: String, required: true, maxlength: 3000 },
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  // new → open (read) → replied → closed. "read" is the stored value for "open" (kept for existing data).
  status: { type: String, enum: CONTACT_STATUSES, default: "new", index: true },
  replies: [{
    message: { type: String, maxlength: 5000 }, by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    at: { type: Date, default: Date.now }, emailed: { type: Boolean, default: false }, emailError: String, _id: false,
  }],
  notes: [{ note: { type: String, maxlength: 2000 }, by: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, at: { type: Date, default: Date.now }, _id: false }],
  lastReplyAt: Date,
}, { timestamps: true });
contactMessageSchema.index({ createdAt: -1 });
contactMessageSchema.index({ user: 1, kind: 1, createdAt: -1 });
toJSONPlugin(contactMessageSchema);
export const ContactMessage = mongoose.model("ContactMessage", contactMessageSchema);

const newsletterSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  status: { type: String, enum: ["subscribed", "unsubscribed"], default: "subscribed" },
  source: { type: String, maxlength: 40, default: "footer" },
}, { timestamps: true });
toJSONPlugin(newsletterSchema);
export const NewsletterSubscriber = mongoose.model("NewsletterSubscriber", newsletterSchema);

/* ---------- FAQs (shown on the storefront Help page) ---------- */
const faqSchema = new mongoose.Schema({
  question: { type: String, required: true, trim: true, maxlength: 300 },
  answer: { type: String, required: true, trim: true, maxlength: 5000 },
  category: { type: String, trim: true, maxlength: 60, default: "General" },
  order: { type: Number, default: 0 },
  status: { type: String, enum: ["active", "hidden"], default: "active", index: true },
}, { timestamps: true });
faqSchema.index({ order: 1, createdAt: 1 });
toJSONPlugin(faqSchema);
export const Faq = mongoose.model("Faq", faqSchema);
