import mongoose from "mongoose";
import { toJSONPlugin } from "./plugins.js";
import { imageSchema, round2 } from "./shared.js";

export const PRODUCT_STATUSES = ["active", "disabled", "archived"];
export const BADGES = ["", "Bestseller", "Trending", "New Drop"];

const productSeoSchema = new mongoose.Schema({
  title: { type: String, maxlength: 70, default: "" },
  description: { type: String, maxlength: 160, default: "" },
  image: { type: imageSchema, default: null },
  robots: { type: String, maxlength: 300, default: "index, follow" },
}, { _id: false });

/* One purchasable combination. Products without options have a single variant (color/size null). */
const variantSchema = new mongoose.Schema({
  sku: { type: String, trim: true, maxlength: 64 },
  color: { type: String, trim: true, maxlength: 40, default: null },
  size: { type: String, trim: true, maxlength: 20, default: null },
  price: { type: Number, required: true, min: 0 },
  mrp: { type: Number, min: 0, default: 0 },
  stock: { type: Number, required: true, min: 0, default: 0, validate: Number.isInteger },
  minStock: { type: Number, min: 0, default: 0, validate: Number.isInteger },
  status: { type: String, enum: ["active", "disabled"], default: "active" },
});
toJSONPlugin(variantSchema);

const colorSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 40 },
  hex: { type: String, match: /^#[0-9a-fA-F]{6}$/, required: true },
  featuredImage: { type: imageSchema, default: null },
  images: { type: [imageSchema], default: [] },
}, { _id: false });

const productContentBlockSchema = new mongoose.Schema({
  type: { type: String, enum: ["banner", "imageRow"], required: true },
  image: { type: imageSchema, default: null },
  images: { type: [imageSchema], default: [] },
}, { _id: false });

const productSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 160 },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 180, match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ },
  sku: { type: String, trim: true, maxlength: 64 },
  legacyId: { type: String, trim: true, maxlength: 40 }, // id on the original static site (product.html?id=…)
  brand: { type: String, trim: true, maxlength: 80, default: "" },
  shortDescription: { type: String, maxlength: 300, default: "" },
  description: { type: String, maxlength: 10_000, default: "" },
  category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },
  // category + all its ancestors, so a product shows under every level of its branch.
  categoryPath: [{ type: mongoose.Schema.Types.ObjectId, ref: "Category" }],
  images: { type: [imageSchema], default: [] }, // Shared gallery; colour galleries take precedence when present.
  colors: { type: [colorSchema], default: [] },
  contentBlocks: { type: [productContentBlockSchema], default: [] },
  sizes: [{ type: String, trim: true, maxlength: 20 }],
  variants: { type: [variantSchema], validate: [(v) => v.length > 0, "A product needs at least one variant."] },
  specs: [{ label: { type: String, maxlength: 60 }, value: { type: String, maxlength: 200 }, _id: false }],
  weightGrams: { type: Number, min: 0 },
  dimensionsCm: { length: Number, width: Number, height: Number },
  isNewArrival: { type: Boolean, default: false }, // not `isNew`: Mongoose reserves that name
  isBestseller: { type: Boolean, default: false },
  isTrending: { type: Boolean, default: false },
  isFeatured: { type: Boolean, default: false },
  badge: { type: String, trim: true, maxlength: 40, default: "" },
  occasions: [{ type: String, trim: true, maxlength: 40 }],
  status: { type: String, enum: PRODUCT_STATUSES, default: "active", index: true },
  // Per-product low-stock alert level; null = the store-wide threshold (Inventory settings).
  lowStockThreshold: { type: Number, min: 0, max: 100_000, default: null },
  seo: { type: productSeoSchema, default: () => ({}) },

  // Derived on save from active variants — used for listing, filtering and sorting.
  minPrice: Number,
  maxPrice: Number,
  mrp: Number,
  discountPct: { type: Number, default: 0 },
  totalStock: { type: Number, default: 0 },
  soldCount: { type: Number, default: 0 },
}, { timestamps: true });

productSchema.index({ legacyId: 1 }, { unique: true, partialFilterExpression: { legacyId: { $type: "string" } } });
productSchema.index({ sku: 1 }, { unique: true, partialFilterExpression: { sku: { $type: "string" } } });
productSchema.index({ "variants.sku": 1 }, { unique: true, partialFilterExpression: { "variants.sku": { $type: "string" } } });
productSchema.index({ status: 1, categoryPath: 1, minPrice: 1 });
productSchema.index({ status: 1, createdAt: -1 });
productSchema.index({ name: "text", brand: "text", description: "text" }, { weights: { name: 5, brand: 3, description: 1 } });

export function deriveProductFields(doc) {
  const live = doc.variants.filter((v) => v.status === "active");
  const pool = live.length ? live : doc.variants;
  const prices = pool.map((v) => round2(v.price));
  doc.minPrice = Math.min(...prices);
  doc.maxPrice = Math.max(...prices);
  doc.mrp = Math.max(0, ...pool.map((v) => v.mrp || 0));
  doc.discountPct = doc.mrp > doc.minPrice ? Math.round((1 - doc.minPrice / doc.mrp) * 100) : 0;
  doc.totalStock = live.reduce((s, v) => s + v.stock, 0);
}

productSchema.pre("validate", function derive() {
  if (this.variants?.length) deriveProductFields(this);
});

toJSONPlugin(productSchema);

export const Product = mongoose.model("Product", productSchema);
