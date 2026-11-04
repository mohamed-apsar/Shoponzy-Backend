import mongoose from "mongoose";
import { toJSONPlugin } from "./plugins.js";
import { imageSchema, seoSchema } from "./shared.js";

export const MAX_CATEGORY_LEVEL = 5;

/* Hierarchy: Category (1) → Sub (2) → Child (3) → Second child (4) → Third child (5).
   `ancestors` (root first) and `path` ("shoes/sneakers") are maintained by categoryService. */
const categorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  slug: { type: String, required: true, trim: true, lowercase: true, maxlength: 80, match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ },
  parent: { type: mongoose.Schema.Types.ObjectId, ref: "Category", default: null },
  ancestors: [{ type: mongoose.Schema.Types.ObjectId, ref: "Category" }],
  level: { type: Number, required: true, min: 1, max: MAX_CATEGORY_LEVEL },
  path: { type: String, required: true, unique: true },
  description: { type: String, maxlength: 2000, default: "" },
  image: { type: imageSchema, default: null },
  productImage: { type: imageSchema, default: null },
  exploreImage: { type: imageSchema, default: null },
  bannerImage: { type: imageSchema, default: null },
  order: { type: Number, default: 0 },
  status: { type: String, enum: ["enabled", "disabled"], default: "enabled", index: true },
  seo: { type: seoSchema, default: () => ({}) },
  // Storefront presentation (menus, heroes, banners). Optional; the site has sensible fallbacks.
  display: {
    tagline: { type: String, maxlength: 80, default: "" },
    color: { type: String, match: /^#[0-9a-fA-F]{6}$/ },
    gradient: [{ type: String, match: /^#[0-9a-fA-F]{6}$/ }],
    artKind: { type: String, maxlength: 20 },
    artColor: { type: String, match: /^#[0-9a-fA-F]{6}$/ },
    heroArt: [{ kind: String, color: String, _id: false }],
    bannerArt: { kind: String, color: String },
  },
}, { timestamps: true });

categorySchema.index({ parent: 1, slug: 1 }, { unique: true });
categorySchema.index({ level: 1, order: 1, name: 1 });
categorySchema.index({ ancestors: 1 });
toJSONPlugin(categorySchema);

export const Category = mongoose.model("Category", categorySchema);
