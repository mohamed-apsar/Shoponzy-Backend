import { Category, MAX_CATEGORY_LEVEL } from "../models/Category.js";
import { Product } from "../models/Product.js";
import { AppError } from "../utils/AppError.js";
import { imageIds, releaseImages, resolveImage, resolveImageKeeping } from "./uploadService.js";

const GALLERY_SLOTS = ["image1", "image2", "image3"];
const plain = (img) => img?.toObject?.() ?? img ?? null;
const galleryImages = (cat) => GALLERY_SLOTS.map((slot) => cat.images?.[slot]).filter(Boolean);

async function resolveGallery(images = {}) {
  const out = {};
  for (const slot of GALLERY_SLOTS) out[slot] = await resolveImage(images[slot]);
  return out;
}

async function loadParent(parentId) {
  if (!parentId) return null;
  const parent = await Category.findById(parentId);
  if (!parent) throw AppError.badRequest("Parent category not found.");
  return parent;
}

function placement(parent, slug) {
  return parent
    ? { parent: parent._id, ancestors: [...parent.ancestors, parent._id], level: parent.level + 1, path: `${parent.path}/${slug}` }
    : { parent: null, ancestors: [], level: 1, path: slug };
}

async function assertUniqueSlug(parentId, slug, exceptId) {
  const clash = await Category.exists({ parent: parentId || null, slug, ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
  if (clash) throw AppError.conflict("Another category under the same parent already uses this slug.");
}

export async function createCategory(data) {
  const parent = await loadParent(data.parent);
  const place = placement(parent, data.slug);
  if (place.level > MAX_CATEGORY_LEVEL) throw AppError.badRequest(`Categories can be nested at most ${MAX_CATEGORY_LEVEL} levels deep.`);
  await assertUniqueSlug(place.parent, data.slug);
  return Category.create({
    ...data,
    ...place,
    image: await resolveImage(data.image),
    productImage: await resolveImage(data.productImage),
    exploreImage: await resolveImage(data.exploreImage),
    bannerImage: await resolveImage(data.bannerImage),
    images: await resolveGallery(data.images),
  });
}

/* Re-derives ancestors/level/path for every descendant, and categoryPath for affected products. */
async function rebuildBranch(root) {
  const descendants = await Category.find({ ancestors: root._id }).sort({ level: 1 });
  const byId = new Map([[String(root._id), root]]);
  for (const d of descendants) {
    const parent = byId.get(String(d.parent));
    Object.assign(d, placement(parent, d.slug));
    await d.save();
    byId.set(String(d._id), d);
  }
  for (const cat of byId.values()) {
    await Product.updateMany({ category: cat._id }, { $set: { categoryPath: [...cat.ancestors, cat._id] } });
  }
}

export async function updateCategory(id, data) {
  const cat = await Category.findById(id);
  if (!cat) throw AppError.notFound("Category not found.");
  const oldImage = cat.image;
  const oldProductImage = cat.productImage;
  const oldExploreImage = cat.exploreImage;
  const oldBannerImage = cat.bannerImage;

  const parentChanged = data.parent !== undefined && String(data.parent || "") !== String(cat.parent || "");
  const slugChanged = data.slug !== undefined && data.slug !== cat.slug;
  if (parentChanged || slugChanged) {
    const parent = parentChanged ? await loadParent(data.parent) : await loadParent(cat.parent);
    if (parent && (parent._id.equals(cat._id) || parent.ancestors.some((a) => a.equals(cat._id)))) {
      throw AppError.badRequest("A category can't be moved under itself or one of its own subcategories.");
    }
    const slug = data.slug ?? cat.slug;
    const place = placement(parent, slug);
    // The whole branch moves: its deepest descendant must still fit within the level limit.
    const deepest = await Category.findOne({ ancestors: cat._id }).sort({ level: -1 }).select("level").lean();
    const depthBelow = deepest ? deepest.level - cat.level : 0;
    if (place.level + depthBelow > MAX_CATEGORY_LEVEL) throw AppError.badRequest(`This move would nest categories deeper than ${MAX_CATEGORY_LEVEL} levels.`);
    await assertUniqueSlug(place.parent, slug, cat._id);
    Object.assign(cat, place, { slug });
  }

  const { parent: _p, slug: _s, image, productImage, exploreImage, bannerImage, images, ...rest } = data;
  Object.assign(cat, rest);
  // Only the slots present in the request change; the others keep their stored image.
  const replacedGallery = [];
  for (const slot of GALLERY_SLOTS) {
    if (images?.[slot] === undefined) continue;
    const old = plain(cat.images?.[slot]);
    const next = await resolveImageKeeping(images[slot], old);
    cat.set(`images.${slot}`, next);
    if (old?.publicId && old.publicId !== next?.publicId) replacedGallery.push(old);
  }
  if (image !== undefined) cat.image = await resolveImageKeeping(image, cat.image?.toObject?.() ?? cat.image);
  if (productImage !== undefined) cat.productImage = await resolveImageKeeping(productImage, cat.productImage?.toObject?.() ?? cat.productImage);
  if (exploreImage !== undefined) cat.exploreImage = await resolveImageKeeping(exploreImage, cat.exploreImage?.toObject?.() ?? cat.exploreImage);
  if (bannerImage !== undefined) cat.bannerImage = await resolveImageKeeping(bannerImage, cat.bannerImage?.toObject?.() ?? cat.bannerImage);
  await cat.save();
  if (parentChanged || slugChanged) await rebuildBranch(cat);
  if (image !== undefined && oldImage?.publicId !== cat.image?.publicId) await releaseImages(imageIds(oldImage));
  if (productImage !== undefined && oldProductImage?.publicId !== cat.productImage?.publicId) await releaseImages(imageIds(oldProductImage));
  if (exploreImage !== undefined && oldExploreImage?.publicId !== cat.exploreImage?.publicId) await releaseImages(imageIds(oldExploreImage));
  if (bannerImage !== undefined && oldBannerImage?.publicId !== cat.bannerImage?.publicId) await releaseImages(imageIds(oldBannerImage));
  if (replacedGallery.length) await releaseImages(imageIds(replacedGallery));
  return cat;
}

export async function deleteCategory(id) {
  const cat = await Category.findById(id);
  if (!cat) throw AppError.notFound("Category not found.");
  const children = await Category.countDocuments({ parent: cat._id });
  if (children) throw AppError.conflict(`Delete or move its ${children} subcategor${children === 1 ? "y" : "ies"} first.`);
  const products = await Product.countDocuments({ categoryPath: cat._id, status: { $ne: "archived" } });
  if (products) throw AppError.conflict(`${products} product${products === 1 ? " is" : "s are"} still in this category. Move or archive them first.`);
  await Product.updateMany({ categoryPath: cat._id }, { $pull: { categoryPath: cat._id } });
  await cat.deleteOne();
  await releaseImages(imageIds(cat.image, cat.productImage, cat.exploreImage, cat.bannerImage, galleryImages(cat)));
}

/* Deletes several categories, deepest first, so a parent selected together with its children goes too.
   Each one still follows deleteCategory's rules; failures are reported per id instead of stopping the batch. */
export async function bulkDeleteCategories(ids) {
  const cats = await Category.find({ _id: { $in: ids } }).select("_id name level").lean();
  const found = new Set(cats.map((c) => String(c._id)));
  const results = ids.filter((id) => !found.has(String(id))).map((id) => ({ id, ok: false, error: "Category not found." }));
  for (const cat of cats.sort((a, b) => b.level - a.level)) {
    try {
      await deleteCategory(cat._id);
      results.push({ id: String(cat._id), name: cat.name, ok: true });
    } catch (err) {
      results.push({ id: String(cat._id), name: cat.name, ok: false, error: err.message });
    }
  }
  return results;
}

/* Ids of disabled categories and everything below them: their products are hidden from the storefront. */
export async function hiddenCategoryIds() {
  const disabled = await Category.find({ status: "disabled" }).select("_id").lean();
  if (!disabled.length) return [];
  const ids = disabled.map((c) => c._id);
  const below = await Category.find({ ancestors: { $in: ids } }).select("_id").lean();
  return [...ids, ...below.map((c) => c._id)];
}

/* Nested tree of enabled categories for menus. */
export async function publicTree() {
  const hidden = new Set((await hiddenCategoryIds()).map(String));
  const all = (await Category.find().sort({ level: 1, order: 1, name: 1 }).lean()).filter((c) => !hidden.has(String(c._id)));
  const nodes = new Map(all.map((c) => [String(c._id), { ...publicCategory(c), children: [] }]));
  const roots = [];
  for (const c of all) (c.parent ? nodes.get(String(c.parent))?.children : roots)?.push(nodes.get(String(c._id)));
  return roots;
}

export const publicCategory = (c) => ({
  id: String(c._id), name: c.name, slug: c.slug, path: c.path, level: c.level, parent: c.parent ? String(c.parent) : null,
  description: c.description, image: c.image, productImage: c.productImage, exploreImage: c.exploreImage, bannerImage: c.bannerImage,
  images: { image1: c.images?.image1 || null, image2: c.images?.image2 || null, image3: c.images?.image3 || null }, order: c.order, seo: c.seo, display: c.display,
  comingSoon: Boolean(c.comingSoon),
});
