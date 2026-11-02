import { Product } from "../models/Product.js";
import { Category } from "../models/Category.js";
import { AppError } from "../utils/AppError.js";
import { escapeRegex } from "../validators/common.js";
import { hiddenCategoryIds } from "./categoryService.js";
import { publicProduct } from "./productService.js";

const SORTS = {
  featured: { isFeatured: -1, createdAt: -1, _id: -1 },
  new: { isNewArrival: -1, createdAt: -1, _id: -1 },
  low: { minPrice: 1, _id: 1 },
  high: { minPrice: -1, _id: 1 },
  off: { discountPct: -1, _id: 1 },
  bestselling: { soldCount: -1, isBestseller: -1, _id: 1 },
};

async function categoryByPath(path) {
  const cat = await Category.findOne({ path, status: "enabled" }).lean();
  if (!cat) throw AppError.notFound("Category not found.");
  const hidden = (await hiddenCategoryIds()).map(String);
  if (cat.ancestors.some((a) => hidden.includes(String(a)))) throw AppError.notFound("Category not found.");
  return cat;
}

/* Visible products: active, and not inside a disabled category branch. */
async function visibleFilter() {
  const hidden = await hiddenCategoryIds();
  return { status: "active", ...(hidden.length ? { categoryPath: { $nin: hidden } } : {}) };
}

export async function listProducts(q) {
  const base = await visibleFilter();
  let category = null, subs = [];
  if (q.category) {
    category = await categoryByPath(q.category);
    base.categoryPath = { ...(base.categoryPath || {}), $all: [category._id] };
    subs = await Category.find({ parent: category._id, status: "enabled" }).sort({ order: 1, name: 1 }).lean();
  }
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), "i");
    const cats = await Category.find({ name: rx }).select("_id").lean();
    base.$or = [{ name: rx }, { brand: rx }, { "colors.name": rx }, ...(cats.length ? [{ categoryPath: { $in: cats.map((c) => c._id) } }] : [])];
  }
  if (q.flag) base[{ new: "isNewArrival", bestseller: "isBestseller", trending: "isTrending", featured: "isFeatured" }[q.flag]] = true;

  // Narrowing filters (facets are computed before these, so options don't disappear as you click).
  const filter = { ...base, $and: [] };
  if (q.sub?.length) {
    const subIds = subs.filter((s) => q.sub.includes(s.slug)).map((s) => s._id);
    filter.$and.push({ categoryPath: { $in: subIds } });
  }
  if (q.cats?.length) {
    const tops = await Category.find({ level: 1, slug: { $in: q.cats } }).select("_id").lean();
    filter.$and.push({ categoryPath: { $in: tops.map((t) => t._id) } });
  }
  if (q.sizes?.length) filter.$and.push({ sizes: { $in: q.sizes } });
  if (q.colors?.length) filter.$and.push({ "colors.name": { $in: q.colors } });
  if (q.minPrice !== undefined) filter.$and.push({ minPrice: { $gte: q.minPrice } });
  if (q.maxPrice !== undefined) filter.$and.push({ minPrice: { $lte: q.maxPrice } });
  if (q.sale) filter.$and.push({ discountPct: { $gt: 0 } });
  if (q.inStock) filter.$and.push({ totalStock: { $gt: 0 } });
  if (!filter.$and.length) delete filter.$and;

  const skip = (q.page - 1) * q.limit;
  const [items, total, facets] = await Promise.all([
    Product.find(filter).sort(SORTS[q.sort] || SORTS.featured).skip(skip).limit(q.limit).lean(),
    Product.countDocuments(filter),
    q.facets ? computeFacets(base, subs) : null,
  ]);
  return {
    items: items.map(publicProduct),
    meta: { page: q.page, limit: q.limit, total, pages: Math.ceil(total / q.limit) },
    ...(facets ? { facets } : {}),
    ...(category ? { category: { id: String(category._id), name: category.name, slug: category.slug, path: category.path, description: category.description, image: category.image, seo: category.seo, display: category.display } } : {}),
  };
}

async function computeFacets(base, subs) {
  const [agg] = await Product.aggregate([
    { $match: base },
    { $facet: {
      sizes: [{ $unwind: "$sizes" }, { $group: { _id: "$sizes", count: { $sum: 1 } } }],
      colors: [{ $unwind: "$colors" }, { $group: { _id: "$colors.name", hex: { $first: "$colors.hex" }, count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 14 }],
      price: [{ $group: { _id: null, min: { $min: "$minPrice" }, max: { $max: "$minPrice" } } }],
      paths: [{ $unwind: "$categoryPath" }, { $group: { _id: "$categoryPath", count: { $sum: 1 } } }],
    } },
  ]);
  const counts = new Map(agg.paths.map((p) => [String(p._id), p.count]));
  const tops = subs.length ? [] : await Category.find({ level: 1, status: "enabled" }).sort({ order: 1, name: 1 }).lean();
  const sizeOrder = (s) => (/^\d+(\.\d+)?$/.test(s) ? Number(s) : ["XS", "S", "M", "L", "XL", "XXL", "XXXL"].indexOf(s) + 1000);
  return {
    subcategories: subs.map((s) => ({ slug: s.slug, name: s.name, count: counts.get(String(s._id)) || 0, display: s.display })),
    categories: tops.map((c) => ({ slug: c.slug, name: c.name, count: counts.get(String(c._id)) || 0 })),
    sizes: agg.sizes.sort((a, b) => sizeOrder(a._id) - sizeOrder(b._id) || a._id.localeCompare(b._id)).map((s) => ({ value: s._id, count: s.count })),
    colors: agg.colors.map((c) => ({ name: c._id, hex: c.hex, count: c.count })),
    price: agg.price[0] ? { min: agg.price[0].min, max: agg.price[0].max } : { min: 0, max: 0 },
  };
}

export async function getProductBySlug(slug) {
  const p = await Product.findOne({ slug, ...(await visibleFilter()) }).populate("category", "name slug path").lean();
  if (!p) throw AppError.notFound("Product not found.");
  return publicProduct(p, { includeContentBlocks: true });
}

export async function relatedProducts(productId, limit = 10) {
  const p = await Product.findById(productId).lean();
  if (!p) throw AppError.notFound("Product not found.");
  const vis = await visibleFilter();
  const same = await Product.find({ ...vis, _id: { $ne: p._id }, category: p.category }).sort(SORTS.featured).limit(limit).lean();
  const more = same.length < limit
    ? await Product.find({ ...vis, _id: { $nin: [p._id, ...same.map((x) => x._id)] } }).sort(SORTS.featured).limit(limit - same.length).lean()
    : [];
  return [...same, ...more].map(publicProduct);
}

export async function productsByIds(ids) {
  const vis = await visibleFilter();
  const docs = await Product.find({ ...vis, _id: { $in: ids } }).lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  return ids.map((id) => byId.get(String(id))).filter(Boolean).map(publicProduct);
}

export { visibleFilter, SORTS };
