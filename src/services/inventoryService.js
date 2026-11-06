import mongoose from "mongoose";
import { Product } from "../models/Product.js";
import { InventoryMovement, Order } from "../models/commerce.js";
import { escapeRegex } from "../validators/common.js";
import { getSection } from "./settingsService.js";
import { lowVariantsExpr } from "./productService.js";

/* Stock is taken off a variant when an order is placed, so `variant.stock` is already the stock
   available to sell. "Reserved" is what unshipped orders are holding (awaiting payment or not yet
   dispatched) — shown for information; it is not subtracted again. */
const HOLDING_STATUSES = ["pending_payment", "placed", "confirmed", "packed"];

export const getLowStockThreshold = async () => (await getSection("inventory")).lowStockThreshold;

const { ObjectId } = mongoose.Types;
const notArchived = { status: { $ne: "archived" } };

export async function inventorySummary() {
  const threshold = await getLowStockThreshold();
  const [products] = await Product.aggregate([
    { $match: notArchived },
    { $project: {
      totalStock: 1,
      activeVariants: { $size: { $filter: { input: "$variants", as: "v", cond: { $eq: ["$$v.status", "active"] } } } },
      outVariants: { $size: { $filter: { input: "$variants", as: "v", cond: { $and: [{ $eq: ["$$v.status", "active"] }, { $lte: ["$$v.stock", 0] }] } } } },
      lowVariants: { $size: lowVariantsExpr(threshold) },
    } },
    { $group: {
      _id: null,
      totalProducts: { $sum: 1 },
      totalStock: { $sum: "$totalStock" },
      totalVariants: { $sum: "$activeVariants" },
      lowStockProducts: { $sum: { $cond: [{ $gt: ["$lowVariants", 0] }, 1, 0] } },
      lowStockVariants: { $sum: "$lowVariants" },
      // A product is out of stock when none of its active variants can be sold.
      outOfStockProducts: { $sum: { $cond: [{ $lte: ["$totalStock", 0] }, 1, 0] } },
      outOfStockVariants: { $sum: "$outVariants" },
    } },
  ]);
  const [reserved] = await Order.aggregate([
    { $match: { stockReserved: true, status: { $in: HOLDING_STATUSES } } },
    { $unwind: "$items" },
    { $group: { _id: null, qty: { $sum: "$items.qty" } } },
  ]);
  const { _id, ...totals } = products || { totalProducts: 0, totalStock: 0, totalVariants: 0, lowStockProducts: 0, lowStockVariants: 0, outOfStockProducts: 0, outOfStockVariants: 0 };
  return { ...totals, reservedUnits: reserved?.qty || 0, lowStockThreshold: threshold };
}

const STOCK_SORTS = {
  stock_low: { stock: 1, name: 1 },
  stock_high: { stock: -1, name: 1 },
  name: { name: 1, variantLabel: 1 },
  updated: { updatedAt: -1 },
};

/* One row per variant (stock lives on variants). */
export async function listStock({ q, category, stockStatus, productStatus, sort = "stock_low", page, limit }) {
  const threshold = await getLowStockThreshold();
  const match = productStatus ? { status: productStatus } : { ...notArchived };
  if (category) match.categoryPath = new ObjectId(category);
  const pipeline = [{ $match: match }, { $unwind: "$variants" }];
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    pipeline.push({ $match: { $or: [{ name: rx }, { brand: rx }, { sku: rx }, { "variants.sku": rx }] } });
  }
  pipeline.push(
    { $addFields: {
      stock: "$variants.stock",
      threshold: { $ifNull: ["$lowStockThreshold", threshold] },
      variantLabel: { $trim: { input: { $concat: [{ $ifNull: ["$variants.color", ""] }, " ", { $ifNull: ["$variants.size", ""] }] } } },
    } },
    { $addFields: {
      stockStatus: { $switch: { branches: [
        { case: { $ne: ["$variants.status", "active"] }, then: "inactive" },
        { case: { $lte: ["$stock", 0] }, then: "out" },
        { case: { $lte: ["$stock", "$threshold"] }, then: "low" },
      ], default: "in" } },
    } },
  );
  if (stockStatus) pipeline.push({ $match: { stockStatus } });
  const skip = (page - 1) * limit;
  pipeline.push({ $facet: {
    total: [{ $count: "n" }],
    items: [
      { $sort: { ...STOCK_SORTS[sort], _id: 1 } }, { $skip: skip }, { $limit: limit },
      { $lookup: { from: "categories", localField: "category", foreignField: "_id", as: "cat", pipeline: [{ $project: { name: 1, path: 1 } }] } },
      { $project: {
        _id: 0, productId: "$_id", variantId: "$variants._id", name: 1, brand: 1, slug: 1, productStatus: "$status",
        sku: { $ifNull: ["$variants.sku", "$sku"] }, color: "$variants.color", size: "$variants.size", variantLabel: 1,
        variantStatus: "$variants.status", price: "$variants.price",
        stock: 1, threshold: 1, productThreshold: "$lowStockThreshold", stockStatus: 1,
        image: { $ifNull: [{ $first: "$images.url" }, { $first: { $map: { input: "$colors", as: "c", in: "$$c.featuredImage.url" } } }] },
        category: { $first: "$cat" }, updatedAt: 1,
      } },
    ],
  } });
  const [{ total, items }] = await Product.aggregate(pipeline);

  // Reserved quantity and the latest stock movement, for just the rows on this page.
  const variantIds = items.map((i) => i.variantId);
  const [reserved, lastMoves] = await Promise.all([
    Order.aggregate([
      { $match: { stockReserved: true, status: { $in: HOLDING_STATUSES }, "items.variant": { $in: variantIds } } },
      { $unwind: "$items" },
      { $match: { "items.variant": { $in: variantIds } } },
      { $group: { _id: "$items.variant", qty: { $sum: "$items.qty" } } },
    ]),
    InventoryMovement.aggregate([
      { $match: { variant: { $in: variantIds } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: "$variant", at: { $first: "$createdAt" } } },
    ]),
  ]);
  const reservedBy = new Map(reserved.map((r) => [String(r._id), r.qty]));
  const movedAt = new Map(lastMoves.map((m) => [String(m._id), m.at]));
  const rows = items.map((i) => ({
    ...i,
    productId: String(i.productId), variantId: String(i.variantId),
    category: i.category ? { id: String(i.category._id), name: i.category.name, path: i.category.path } : null,
    reserved: reservedBy.get(String(i.variantId)) || 0,
    lastUpdated: movedAt.get(String(i.variantId)) || i.updatedAt,
  }));
  return { items: rows, total: total[0]?.n || 0, threshold };
}

/* ---------- Stock adjustment history (the existing InventoryMovement log) ---------- */
export async function movementFilter({ q, product, reason, from, to, manual }) {
  const filter = {};
  if (product) filter.product = new ObjectId(product);
  if (reason) filter.reason = reason;
  else if (manual) filter.actor = { $ne: null };
  if (from || to) filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    const ids = (await Product.find({ $or: [{ name: rx }, { sku: rx }, { "variants.sku": rx }] }).select("_id").limit(500).lean()).map((p) => p._id);
    filter.$or = [{ sku: rx }, { product: { $in: ids } }];
  }
  return filter;
}

const populateMovement = (query) => query
  .populate("product", "name slug variants._id variants.color variants.size")
  .populate("actor", "name email")
  .populate("order", "orderNumber")
  .populate("returnRequest", "returnNumber");

export function movementView(m) {
  const variant = m.product?.variants?.find((v) => String(v._id) === String(m.variant));
  return {
    id: String(m._id), createdAt: m.createdAt,
    product: m.product ? { id: String(m.product._id), name: m.product.name, slug: m.product.slug } : null,
    variant: variant ? [variant.color, variant.size].filter(Boolean).join(" / ") : "",
    variantId: String(m.variant), sku: m.sku || "",
    before: m.before ?? null, delta: m.delta, after: m.after ?? null,
    mode: m.mode || null, reason: m.reason, note: m.note || "",
    actor: m.actor ? { id: String(m.actor._id), name: m.actor.name, email: m.actor.email } : null,
    order: m.order ? { id: String(m.order._id), orderNumber: m.order.orderNumber } : null,
    returnRequest: m.returnRequest ? { id: String(m.returnRequest._id), returnNumber: m.returnRequest.returnNumber } : null,
  };
}

export async function listMovements(query, { skip, limit }) {
  const filter = await movementFilter(query);
  const [items, total] = await Promise.all([
    populateMovement(InventoryMovement.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)).lean(),
    InventoryMovement.countDocuments(filter),
  ]);
  return { items: items.map(movementView), total };
}

export async function movementsCursor(query, max) {
  const filter = await movementFilter(query);
  return populateMovement(InventoryMovement.find(filter).sort({ createdAt: -1 }).limit(max)).lean().cursor();
}
