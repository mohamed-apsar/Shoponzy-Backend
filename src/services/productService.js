import mongoose from "mongoose";
import { Product } from "../models/Product.js";
import { Category } from "../models/Category.js";
import { Cart, InventoryMovement, Order } from "../models/commerce.js";
import { User } from "../models/User.js";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";
import { slugify } from "../utils/slugify.js";
import { imageIds, releaseImages, resolveImageKeeping, resolveImages, resolveImagesKeeping } from "./uploadService.js";

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

async function resolveProductColors(colors, existingColors = []) {
  return Promise.all(colors.map(async (color, index) => {
    const existing = existingColors.find((item) => item.name === color.name) || existingColors[index];
    const existingImages = [existing?.featuredImage, ...(existing?.images || [])].filter(Boolean)
      .map((image) => image.toObject ? image.toObject() : image);
    const featuredImage = color.featuredImage === undefined
      ? existing?.featuredImage || null
      : await resolveImageKeeping(color.featuredImage, existingImages);
    const images = color.images === undefined
      ? existing?.images || []
      : await resolveImagesKeeping(color.images, existingImages);
    return { ...color, featuredImage, images };
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
    (product.colors || []).flatMap((color) => [color.featuredImage, ...(color.images || [])]),
    (product.contentBlocks || []).flatMap((block) => [block.image, ...(block.images || [])]),
  );
}

async function categoryPathFor(categoryId) {
  const cat = await Category.findById(categoryId).lean();
  if (!cat) throw AppError.badRequest("Category not found.");
  return [...cat.ancestors, cat._id];
}

export async function createProduct(input, actor) {
  const { price: _p, mrp: _m, stock: _s, ...rest } = input;
  const opts = normaliseVariants(input);
  const product = new Product({
    ...rest, ...opts,
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
  const product = await Product.findById(id);
  if (!product) throw AppError.notFound("Product not found.");
  const oldImages = productImageIds(product);
  const before = new Map(product.variants.map((v) => [String(v._id), v.stock]));

  const { price: _p, mrp: _m, stock: _s, images, contentBlocks, slug, category, variants: _v, colors: _c, sizes: _z, ...rest } = input;
  Object.assign(product, rest);
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
  if (images || input.colors !== undefined || contentBlocks !== undefined) {
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

/* Atomic stock change for one variant. `set` is converted to a delta against the current value. */
export async function adjustStock(productId, variantId, { delta, set, reason = "adjustment", note }, actor) {
  const product = await Product.findOne({ _id: productId, "variants._id": variantId }, { "variants.$": 1 }).lean();
  if (!product) throw AppError.notFound("Product or variant not found.");
  const change = set !== undefined ? set - product.variants[0].stock : delta;
  if (!Number.isInteger(change) || change === 0) throw AppError.badRequest("Nothing to change.");
  const res = await Product.updateOne(
    { _id: productId, variants: { $elemMatch: { _id: variantId, stock: { $gte: Math.max(0, -change) } } } },
    { $inc: { "variants.$.stock": change, ...(product.variants[0].status === "active" ? { totalStock: change } : {}) } },
  );
  if (!res.modifiedCount) throw AppError.conflict("Stock changed in the meantime or would go below zero. Refresh and try again.");
  await InventoryMovement.create({ product: productId, variant: variantId, sku: product.variants[0].sku, delta: change, reason, note, actor: actor?._id });
  return Product.findById(productId);
}

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
