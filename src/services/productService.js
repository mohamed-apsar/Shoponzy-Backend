import mongoose from "mongoose";
import { Product } from "../models/Product.js";
import { Category } from "../models/Category.js";
import { Cart, InventoryMovement, Order } from "../models/commerce.js";
import { User } from "../models/User.js";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";
import { slugify } from "../utils/slugify.js";
import { inTransaction } from "../utils/transaction.js";
import { imageIds, releaseImages, resolveImageKeeping, resolveImages, resolveImagesKeeping } from "./uploadService.js";
import { validateProductBadge } from "./productBadgeService.js";

async function uniqueSlug(base, exceptId) {
  let slug = base, n = 1;
  while (await Product.exists({ slug, ...(exceptId ? { _id: { $ne: exceptId } } : {}) })) slug = `${base}-${++n}`;
  return slug;
}

/* Turns admin input into a consistent product: variants must match the declared colours/sizes,
   one variant per combination; a product without options gets one default variant. */
function normaliseVariants(input, existing) {
  const colors = input.colors ?? existing?.colors ?? [];
  const sizes = input.sizes ?? existing?.sizes ?? [];
  let variants = input.variants;
  if (!variants) {
    const simple = input.price !== undefined || input.mrp !== undefined || input.stock !== undefined;
    if (!simple && existing) return { colors, sizes, variants: existing.variants };
    if (existing?.variants.length > 1) throw AppError.badRequest("This product has several variants; edit their price and stock individually.");
    // Simple products: update the single variant, keeping whatever wasn't sent.
    const base = existing?.variants[0] || {};
    const price = input.price ?? base.price;
    if (price === undefined) throw AppError.badRequest("Enter a price, or add variants.");
    variants = [{ color: colors[0]?.name ?? null, size: sizes[0] ?? null, price, mrp: input.mrp ?? base.mrp ?? 0, stock: input.stock ?? base.stock ?? 0, sku: input.sku ?? base.sku }];
  }
  const colorNames = new Set(colors.map((c) => c.name));
  const seen = new Set();
  for (const v of variants) {
    if (colors.length ? !colorNames.has(v.color) : v.color) throw AppError.badRequest(`Variant colour "${v.color}" is not one of the product's colours.`);
    if (sizes.length ? !sizes.includes(v.size) : v.size) throw AppError.badRequest(`Variant size "${v.size}" is not one of the product's sizes.`);
    const key = `${v.color}|${v.size}`;
    if (seen.has(key)) throw AppError.badRequest(`Duplicate variant for ${[v.color, v.size].filter(Boolean).join(" / ")}.`);
    seen.add(key);
    if (v.mrp && v.mrp < v.price) throw AppError.badRequest("MRP can't be lower than the selling price.");
  }
  const skus = variants.map((v) => v.sku).filter(Boolean);
  if (new Set(skus).size !== skus.length) throw AppError.badRequest("Variant SKUs must be unique.");
  // Keep ids of unchanged combinations so carts and orders that reference them stay valid.
  const prior = new Map((existing?.variants || []).map((v) => [`${v.color}|${v.size}`, v._id]));
  return { colors, sizes, variants: variants.map((v) => ({ ...v, _id: v.id || prior.get(`${v.color}|${v.size}`) || new mongoose.Types.ObjectId(), sku: v.sku || undefined })) };
}

const ROW_SLOTS = ["image1", "image2", "image3"];
const legacyColorShowcaseBlocks = (color) => [
  ...(color?.bannerImage ? [{ type: "banner", image: color.bannerImage }] : []),
  ...(ROW_SLOTS.some((slot) => color?.rowImages?.[slot]) ? [{ type: "imageRow", images: ROW_SLOTS.map((slot) => color?.rowImages?.[slot]).filter(Boolean) }] : []),
];
const colorShowcaseImages = (color) => [
  color?.bannerImage,
  ...ROW_SLOTS.map((slot) => color?.rowImages?.[slot]),
  ...(color?.showcaseBlocks || []).flatMap((block) => [block.image, ...(block.images || [])]),
].filter(Boolean);

async function resolveProductColors(colors, existingColors = []) {
  return Promise.all(colors.map(async (color, index) => {
    const existing = existingColors.find((item) => item.name === color.name) || existingColors[index];
    const existingImages = [existing?.featuredImage, ...(existing?.images || []), ...colorShowcaseImages(existing)].filter(Boolean)
      .map((image) => image.toObject ? image.toObject() : image);
    const featuredImage = color.featuredImage === undefined
      ? existing?.featuredImage || null
      : await resolveImageKeeping(color.featuredImage, existingImages);
    const images = color.images === undefined
      ? existing?.images || []
      : await resolveImagesKeeping(color.images, existingImages);
    const bannerImage = color.bannerImage === undefined
      ? existing?.bannerImage || null
      : await resolveImageKeeping(color.bannerImage, existingImages);
    // Each row slot is independent: an omitted slot keeps its image, null clears it.
    const rowImages = {};
    for (const slot of ROW_SLOTS) {
      rowImages[slot] = color.rowImages?.[slot] === undefined
        ? existing?.rowImages?.[slot] || null
        : await resolveImageKeeping(color.rowImages[slot], existingImages);
    }
    const priorShowcaseBlocks = existing?.showcaseBlocks?.length ? existing.showcaseBlocks : legacyColorShowcaseBlocks(existing);
    const requestedShowcaseBlocks = color.showcaseBlocks === undefined ? priorShowcaseBlocks : color.showcaseBlocks;
    const showcaseBlocks = await Promise.all(requestedShowcaseBlocks.map(async (block, blockIndex) => {
      const priorBlock = priorShowcaseBlocks[blockIndex]?.type === block.type ? priorShowcaseBlocks[blockIndex] : null;
      if (block.type === "banner") {
        return { type: "banner", image: await resolveImageKeeping(block.image, [priorBlock?.image, ...existingImages].filter(Boolean)), images: [] };
      }
      return { type: "imageRow", image: null, images: await resolveImagesKeeping(block.images, [...(priorBlock?.images || []), ...existingImages].filter(Boolean)) };
    }));
    return { ...color, featuredImage, images, bannerImage, rowImages, showcaseBlocks };
  }));
}

async function resolveProductContentBlocks(blocks = [], existingBlocks = []) {
  return Promise.all(blocks.map(async (block, index) => {
    const existing = existingBlocks[index]?.type === block.type ? existingBlocks[index] : null;
    if (block.type === "banner") {
      const existingImages = existing?.image ? [existing.image.toObject ? existing.image.toObject() : existing.image] : [];
      return { type: block.type, image: await resolveImageKeeping(block.image, existingImages), images: [] };
    }
    const existingImages = (existing?.images || []).map((image) => image.toObject ? image.toObject() : image);
    return {
      type: block.type,
      image: null,
      images: await resolveImagesKeeping(block.images, existingImages),
    };
  }));
}

function productImageIds(product) {
  return imageIds(
    product.images,
    (product.colors || []).flatMap((color) => [color.featuredImage, ...(color.images || []), ...colorShowcaseImages(color)]),
    (product.contentBlocks || []).flatMap((block) => [block.image, ...(block.images || [])]),
    product.seo?.image,
  );
}

async function categoryPathFor(categoryId) {
  const cat = await Category.findById(categoryId).lean();
  if (!cat) throw AppError.badRequest("Category not found.");
  return [...cat.ancestors, cat._id];
}

export async function createProduct(input, actor) {
  await validateProductBadge(input.badge);
  const { price: _p, mrp: _m, stock: _s, seo, ...rest } = input;
  const opts = normaliseVariants(input);
  const product = new Product({
    ...rest, ...opts,
    ...(seo ? { seo: { ...seo, ...(seo.image !== undefined ? { image: await resolveImages([seo.image]).then(([image]) => image) } : {}) } } : {}),
    colors: await resolveProductColors(opts.colors),
    contentBlocks: await resolveProductContentBlocks(input.contentBlocks),
    slug: await uniqueSlug(input.slug || slugify(input.name)),
    categoryPath: await categoryPathFor(input.category),
    images: await resolveImages(input.images),
  });
  await product.save();
  const initial = product.variants.filter((v) => v.stock > 0);
  if (initial.length) {
    await InventoryMovement.insertMany(initial.map((v) => ({ product: product._id, variant: v._id, sku: v.sku, delta: v.stock, reason: "initial", actor: actor?._id })));
  }
  return product;
}

export async function updateProduct(id, input, actor) {
  if (input.badge !== undefined) await validateProductBadge(input.badge);
  const product = await Product.findById(id);
  if (!product) throw AppError.notFound("Product not found.");
  const oldImages = productImageIds(product);
  const before = new Map(product.variants.map((v) => [String(v._id), v.stock]));

  const { price: _p, mrp: _m, stock: _s, images, contentBlocks, slug, category, variants: _v, colors: _c, sizes: _z, seo, ...rest } = input;
  Object.assign(product, rest);
  if (seo) {
    const currentSeo = product.seo?.toObject ? product.seo.toObject() : product.seo || {};
    product.seo = {
      ...currentSeo,
      ...seo,
      ...(seo.image !== undefined ? {
        image: await resolveImageKeeping(seo.image, [currentSeo.image]),
      } : {}),
    };
  }
  if (["variants", "colors", "sizes", "price", "mrp", "stock"].some((k) => input[k] !== undefined)) {
    const options = normaliseVariants(input, product);
    if (input.colors !== undefined) options.colors = await resolveProductColors(options.colors, product.colors);
    Object.assign(product, options);
  }
  if (slug && slug !== product.slug) product.slug = await uniqueSlug(slug, product._id);
  if (category) { product.category = category; product.categoryPath = await categoryPathFor(category); }
  if (images) product.images = await resolveImagesKeeping(images, product.images.map((i) => (i.toObject ? i.toObject() : i)));
  if (contentBlocks !== undefined) product.contentBlocks = await resolveProductContentBlocks(contentBlocks, product.contentBlocks);
  await product.save();

  // Manual stock edits through the form are recorded like any other adjustment.
  const moves = product.variants.map((v) => ({ v, delta: v.stock - (before.get(String(v._id)) ?? 0) })).filter((m) => m.delta !== 0);
  if (moves.length) {
    await InventoryMovement.insertMany(moves.map(({ v, delta }) => ({ product: product._id, variant: v._id, sku: v.sku, delta, reason: "adjustment", actor: actor?._id, note: "Edited in product form" })));
  }
  if (images || input.colors !== undefined || contentBlocks !== undefined || seo?.image !== undefined) {
    const currentImages = productImageIds(product);
    await releaseImages(oldImages.filter((pid) => !currentImages.includes(pid)));
  }
  return product;
}

/* Products that appear in orders are archived (kept for order history); others are deleted. */
export async function deleteProduct(id) {
  const product = await Product.findById(id);
  if (!product) throw AppError.notFound("Product not found.");
  await Cart.updateMany({}, { $pull: { items: { product: product._id } } });
  await User.updateMany({ wishlist: product._id }, { $pull: { wishlist: product._id } });
  if (await Order.exists({ "items.product": product._id })) {
    product.status = "archived";
    await product.save();
    return { archived: true, product };
  }
  await product.deleteOne();
  await releaseImages(productImageIds(product));
  return { archived: false };
}

/* Manual stock change for one variant, inside a transaction together with its movement record.
   `set` becomes a delta against the value read in the same transaction, and the update only applies
   if the stock is still that value — so a concurrent order can't make "set to 10" land on 9.
   `expectedStock` (optional) lets the admin UI refuse to save if the stock changed since it was shown. */
export async function adjustStock(productId, variantId, { delta, set, reason = "adjustment", note, expectedStock }, actor) {
  const movement = await inTransaction(async (session) => {
    const product = await Product.findOne({ _id: productId, "variants._id": variantId }, { "variants.$": 1 }).session(session).lean();
    if (!product) throw AppError.notFound("Product or variant not found.");
    const variant = product.variants[0];
    const before = variant.stock;
    if (expectedStock !== undefined && expectedStock !== before) {
      throw AppError.conflict(`Stock changed to ${before} since you opened this form. Review and try again.`);
    }
    const change = set !== undefined ? set - before : delta;
    if (!Number.isInteger(change) || change === 0) throw AppError.badRequest("Nothing to change: the new quantity equals the current stock.");
    if (before + change < 0) throw AppError.conflict(`Only ${before} in stock; you can remove at most ${before}.`);
    const res = await Product.updateOne(
      { _id: productId, variants: { $elemMatch: { _id: variantId, stock: before } } },
      { $inc: { "variants.$.stock": change, ...(variant.status === "active" ? { totalStock: change } : {}) } },
      { session },
    );
    if (!res.modifiedCount) throw AppError.conflict("Stock changed in the meantime. Refresh and try again.");
    const mode = set !== undefined ? "set" : change > 0 ? "add" : "remove";
    const [m] = await InventoryMovement.create([{
      product: productId, variant: variantId, sku: variant.sku, delta: change, before, after: before + change,
      mode, reason, note, actor: actor?._id,
    }], { session });
    return m;
  });
  return { product: await Product.findById(productId), movement };
}

/* Mongo expression: variants that are active, in stock and at/below the product's alert level. */
export const lowVariantsExpr = (threshold) => ({
  $filter: {
    input: "$variants", as: "v",
    cond: { $and: [{ $eq: ["$$v.status", "active"] }, { $gt: ["$$v.stock", 0] }, { $lte: ["$$v.stock", { $ifNull: ["$lowStockThreshold", threshold] }] }] },
  },
});
/* Query filter: products with at least one low-stock variant. */
export const lowStockFilter = (threshold) => ({ $expr: { $gt: [{ $size: lowVariantsExpr(threshold) }, 0] } });

/* ---------- Storefront view ---------- */
export function publicProduct(p, { includeContentBlocks = false } = {}) {
  const low = env.LOW_STOCK_THRESHOLD;
  return {
    id: String(p._id), slug: p.slug, legacyId: p.legacyId, name: p.name, brand: p.brand,
    shortDescription: p.shortDescription, description: p.description,
    category: p.category && typeof p.category === "object" && p.category.path
      ? { id: String(p.category._id), name: p.category.name, slug: p.category.slug, path: p.category.path }
      : String(p.category),
    categoryPath: (p.categoryPath || []).map(String),
    images: p.images,
    colors: p.colors.map((color) => ({
      name: color.name, hex: color.hex, featuredImage: color.featuredImage || null, images: color.images || [],
      bannerImage: color.bannerImage || null,
      rowImages: { image1: color.rowImages?.image1 || null, image2: color.rowImages?.image2 || null, image3: color.rowImages?.image3 || null },
      showcaseBlocks: color.showcaseBlocks?.length ? color.showcaseBlocks : legacyColorShowcaseBlocks(color),
    })),
    ...(includeContentBlocks ? {
      contentBlocks: (p.contentBlocks || []).map((block) => ({
        type: block.type, image: block.image || null, images: block.images || [],
      })),
    } : {}),
    sizes: p.sizes, specs: p.specs,
    // Exact stock is not exposed; "only N left" appears at or below the low-stock threshold.
    variants: p.variants.filter((v) => v.status === "active").map((v) => ({
      id: String(v._id), sku: v.sku, color: v.color, size: v.size, price: v.price, mrp: v.mrp,
      inStock: v.stock > 0, stockLeft: v.stock > 0 && v.stock <= low ? v.stock : null,
    })),
    price: p.minPrice, priceTo: p.maxPrice > p.minPrice ? p.maxPrice : null, mrp: p.mrp, discountPct: p.discountPct,
    inStock: p.totalStock > 0,
    isNewArrival: p.isNewArrival, isBestseller: p.isBestseller, isTrending: p.isTrending, isFeatured: p.isFeatured, badge: p.badge,
    seo: p.seo, createdAt: p.createdAt,
  };
}
