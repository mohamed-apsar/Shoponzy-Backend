import { Banner, HomepageSection, Popup } from "../models/site.js";
import { Product } from "../models/Product.js";
import { Category } from "../models/Category.js";
import { publicProduct } from "./productService.js";
import { publicCategory } from "./categoryService.js";
import { SORTS, productsByIds, visibleFilter } from "./catalogService.js";

export const inSchedule = (now = new Date()) => ({
  $and: [{ $or: [{ startsAt: null }, { startsAt: { $lte: now } }] }, { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }],
});

export async function activeBanners(placement, now = new Date()) {
  return Banner.find({ status: "active", ...(placement ? { placement } : {}), ...inSchedule(now) }).sort({ order: 1, createdAt: 1 }).lean()
    .then((list) => list.map(({ _id, __v, ...b }) => ({ id: String(_id), ...b })));
}

export async function activePopups(now = new Date()) {
  return Popup.find({ status: "active", ...inSchedule(now) }).sort({ createdAt: -1 }).lean()
    .then((list) => list.map(({ _id, __v, ...p }) => ({ id: String(_id), ...p })));
}

async function sectionProducts(s) {
  const vis = await visibleFilter();
  const find = (extra, sort = SORTS.featured) => Product.find({ ...vis, ...extra }).sort(sort).limit(s.count).lean();
  let docs;
  switch (s.source) {
    case "new": docs = await find({ isNewArrival: true }, SORTS.featured); break;
    case "bestseller": docs = await find({ $or: [{ isBestseller: true }, { isTrending: true }] }); break;
    case "trending": docs = await find({ isTrending: true }); break;
    case "featured": docs = await find({ isFeatured: true }); break;
    case "deals": docs = await find({ discountPct: { $gt: 0 } }, SORTS.off); break;
    case "category": docs = s.category ? await find({ categoryPath: s.category }) : []; break;
    case "manual": return (await productsByIds(s.products)).slice(0, s.count);
    default: docs = [];
  }
  return docs.map(publicProduct);
}

export async function resolvedSections() {
  const sections = await HomepageSection.find({ active: true }).sort({ order: 1 }).lean();
  return Promise.all(sections.map(async (s) => {
    const base = { id: String(s._id), title: s.title, subtitle: s.subtitle, type: s.type, source: s.source, layout: s.layout, buttonText: s.buttonText, url: s.url };
    if (s.type === "categories") {
      const cats = s.categories?.length
        ? await Category.find({ _id: { $in: s.categories }, status: "enabled" }).lean()
        : await Category.find({ level: 1, status: "enabled" }).sort({ order: 1, name: 1 }).limit(s.count).lean();
      return { ...base, categories: cats.map(publicCategory) };
    }
    return { ...base, products: await sectionProducts(s) };
  }));
}
