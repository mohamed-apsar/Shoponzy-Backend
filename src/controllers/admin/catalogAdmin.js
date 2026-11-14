import { Category } from "../../models/Category.js";
import { Product } from "../../models/Product.js";
import { audit } from "../../models/AuditLog.js";
import { getLowStockThreshold } from "../../services/inventoryService.js";
import * as categories from "../../services/categoryService.js";
import * as products from "../../services/productService.js";
import { AppError } from "../../utils/AppError.js";
import { created, ok, paginate } from "../../utils/respond.js";
import { escapeRegex } from "../../validators/common.js";
import { sendCsv } from "../../utils/csv.js";

const actor = (req) => req.auth.user;
const log = (req, action, entity, entityId, meta) => audit(action, { actor: req.auth.user._id, entity, entityId, ip: req.ip, meta });

/* ---------- Categories ---------- */
export async function listCategories(req, res) {
  const { level, parent, status, q, ...pageQ } = req.valid.query;
  const filter = {};
  if (level) filter.level = level;
  if (parent) filter.parent = parent;
  if (status) filter.status = status;
  if (q) filter.$or = [{ name: new RegExp(escapeRegex(q), "i") }, { slug: new RegExp(escapeRegex(q), "i") }];
  const { skip, limit, meta } = paginate(pageQ, 500);
  const [items, total] = await Promise.all([
    Category.find(filter).sort({ level: 1, order: 1, name: 1 }).skip(skip).limit(limit).populate("ancestors", "name slug").lean(),
    Category.countDocuments(filter),
  ]);
  // productCount helps admins see which categories are in use before deleting.
  const categoryIds = items.map((c) => c._id);
  const [counts, productsWithImages] = await Promise.all([
    Product.aggregate([{ $match: { status: { $ne: "archived" }, categoryPath: { $in: categoryIds } } }, { $unwind: "$categoryPath" }, { $group: { _id: "$categoryPath", n: { $sum: 1 } } }]),
    Product.find({ status: { $ne: "archived" }, categoryPath: { $in: categoryIds } })
      .select("categoryPath images colors.featuredImage")
      .sort({ createdAt: 1, _id: 1 })
      .lean(),
  ]);
  const byId = new Map(counts.map((c) => [String(c._id), c.n]));
  const categoryIdSet = new Set(categoryIds.map(String));
  const productImageByCategory = new Map();
  for (const product of productsWithImages) {
    const image = product.images?.find((item) => item.url)
      || product.colors?.find((color) => color.featuredImage?.url)?.featuredImage;
    if (!image) continue;
    for (const categoryId of product.categoryPath || []) {
      const key = String(categoryId);
      if (categoryIdSet.has(key) && !productImageByCategory.has(key)) productImageByCategory.set(key, image);
    }
  }
  ok(res, items.map(({ _id, __v, ancestors, ...c }) => ({
    id: String(_id), ...c, parent: c.parent ? String(c.parent) : null,
    productImage: c.productImage || productImageByCategory.get(String(_id)) || null,
    ancestors: ancestors.map((a) => ({ id: String(a._id), name: a.name, slug: a.slug })),
    pathNames: ancestors.map((a) => a.name).join(" / "), productCount: byId.get(String(_id)) || 0,
  })), meta(total));
}

export async function categoryTree(_req, res) {
  const all = await Category.find().sort({ level: 1, order: 1, name: 1 }).lean();
  const nodes = new Map(all.map((c) => [String(c._id), { id: String(c._id), name: c.name, slug: c.slug, path: c.path, level: c.level, status: c.status, children: [] }]));
  const roots = [];
  for (const c of all) (c.parent ? nodes.get(String(c.parent))?.children : roots)?.push(nodes.get(String(c._id)));
  ok(res, roots);
}

export async function createCategory(req, res) {
  const cat = await categories.createCategory(req.valid.body);
  await log(req, "category.created", "Category", cat._id, { path: cat.path });
  created(res, cat);
}
export async function updateCategory(req, res) {
  const cat = await categories.updateCategory(req.params.id, req.valid.body);
  await log(req, "category.updated", "Category", cat._id, { fields: Object.keys(req.valid.body) });
  ok(res, cat);
}
export async function deleteCategory(req, res) {
  await categories.deleteCategory(req.params.id);
  await log(req, "category.deleted", "Category", req.params.id);
  ok(res, { deleted: true });
}

export async function bulkDeleteCategories(req, res) {
  const results = await categories.bulkDeleteCategories([...new Set(req.valid.body.ids)]);
  const deleted = results.filter((r) => r.ok);
  if (deleted.length) await log(req, "category.bulk_deleted", "Category", null, { ids: deleted.map((r) => r.id), count: deleted.length });
  ok(res, { results, succeeded: deleted.length });
}

/* ---------- Products ---------- */
const PRODUCT_SORTS = { newest: { createdAt: -1 }, oldest: { createdAt: 1 }, name: { name: 1 }, price_low: { minPrice: 1 }, price_high: { minPrice: -1 }, stock_low: { totalStock: 1 } };

export async function listProducts(req, res) {
  const { q, category, status, stock, flag, sort, ...pageQ } = req.valid.query;
  const filter = {};
  filter.status = status || { $ne: "archived" };
  if (category) filter.categoryPath = category;
  if (stock === "out") filter.totalStock = 0;
  if (stock === "in") filter.totalStock = { $gt: 0 };
  if (stock === "low") Object.assign(filter, products.lowStockFilter(await getLowStockThreshold()));
  if (flag) filter[{ new: "isNewArrival", bestseller: "isBestseller", trending: "isTrending", featured: "isFeatured" }[flag]] = true;
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ name: rx }, { sku: rx }, { "variants.sku": rx }, { brand: rx }, { legacyId: rx }];
  }
  const { skip, limit, meta } = paginate(pageQ);
  const [items, total, summary] = await Promise.all([
    Product.find(filter).sort(PRODUCT_SORTS[sort]).skip(skip).limit(limit).populate("category", "name path"),
    Product.countDocuments(filter),
    Product.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  ok(res, items, { ...meta(total), summary: Object.fromEntries(summary.map((s) => [s._id, s.n])) });
}

export async function getProduct(req, res) {
  const p = await Product.findById(req.params.id).populate("category", "name path ancestors");
  if (!p) throw AppError.notFound("Product not found.");
  ok(res, p);
}
export async function createProduct(req, res) {
  const p = await products.createProduct(req.valid.body, actor(req));
  await log(req, "product.created", "Product", p._id, { name: p.name });
  created(res, p);
}
export async function updateProduct(req, res) {
  const p = await products.updateProduct(req.params.id, req.valid.body, actor(req));
  await log(req, "product.updated", "Product", p._id, { fields: Object.keys(req.valid.body) });
  ok(res, p);
}
export async function deleteProduct(req, res) {
  const result = await products.deleteProduct(req.params.id);
  await log(req, result.archived ? "product.archived" : "product.deleted", "Product", req.params.id);
  ok(res, { deleted: !result.archived, archived: result.archived });
}
export async function adjustStock(req, res) {
  const { variantId, ...change } = req.valid.body;
  const { product, movement } = await products.adjustStock(req.params.id, variantId, change, actor(req));
  await log(req, "product.stock_adjusted", "Product", product._id, { variantId, sku: movement.sku, mode: movement.mode, before: movement.before, after: movement.after, reason: movement.reason, note: movement.note });
  ok(res, product);
}

export async function bulkProducts(req, res) {
  const { ids, action } = req.valid.body;
  const results = [];
  for (const id of ids) {
    try {
      if (action === "delete") results.push({ id, ...(await products.deleteProduct(id)), ok: true });
      else {
        const status = { activate: "active", disable: "disabled", archive: "archived" }[action];
        const r = await Product.updateOne({ _id: id }, { $set: { status } });
        results.push({ id, ok: r.matchedCount === 1 });
      }
    } catch (err) {
      results.push({ id, ok: false, error: err.message });
    }
  }
  await log(req, "product.bulk", "Product", null, { action, count: ids.length });
  ok(res, { results, succeeded: results.filter((r) => r.ok).length });
}

/* CSV export (one row per variant) for spreadsheets. */
export async function exportProducts(_req, res) {
  const rows = [["product_id", "name", "slug", "category", "brand", "status", "variant_id", "sku", "color", "size", "price", "mrp", "stock"]];
  const cursor = Product.find({ status: { $ne: "archived" } }).populate("category", "path").sort({ name: 1 }).cursor();
  for await (const p of cursor) {
    for (const v of p.variants) rows.push([p._id, p.name, p.slug, p.category?.path, p.brand, p.status, v._id, v.sku, v.color, v.size, v.price, v.mrp, v.stock]);
  }
  sendCsv(res, `shoponzy-products-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}
/* Stock history (InventoryMovement) is served by inventoryAdmin.js. */
