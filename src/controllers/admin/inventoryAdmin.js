import { Product } from "../../models/Product.js";
import { audit } from "../../models/AuditLog.js";
import * as inventory from "../../services/inventoryService.js";
import * as settings from "../../services/settingsService.js";
import { AppError } from "../../utils/AppError.js";
import { ok, paginate } from "../../utils/respond.js";
import { MAX_EXPORT_ROWS, csvDate, sendCsv } from "../../utils/csv.js";

export const summary = async (_req, res) => ok(res, await inventory.inventorySummary());

export async function list(req, res) {
  const { page, limit, meta } = paginate(req.valid.query);
  const { items, total, threshold } = await inventory.listStock({ ...req.valid.query, page, limit });
  ok(res, items, { ...meta(total), lowStockThreshold: threshold });
}

export const getSettings = async (_req, res) => ok(res, await settings.getSection("inventory"));

export async function updateSettings(req, res) {
  const { value, previous } = await settings.updateSection("inventory", req.valid.body);
  await audit("inventory.settings_updated", { actor: req.auth.user._id, entity: "SiteSetting", entityId: "inventory", ip: req.ip, meta: { from: previous.lowStockThreshold, to: value.lowStockThreshold } });
  ok(res, value);
}

export async function setProductThreshold(req, res) {
  const product = await Product.findByIdAndUpdate(req.params.id, { $set: { lowStockThreshold: req.valid.body.lowStockThreshold } }, { new: true, runValidators: true }).select("name lowStockThreshold");
  if (!product) throw AppError.notFound("Product not found.");
  await audit("product.low_stock_threshold", { actor: req.auth.user._id, entity: "Product", entityId: product._id, ip: req.ip, meta: { lowStockThreshold: product.lowStockThreshold } });
  ok(res, { id: String(product._id), name: product.name, lowStockThreshold: product.lowStockThreshold });
}

export async function movements(req, res) {
  const { skip, limit, meta } = paginate(req.valid.query);
  const { items, total } = await inventory.listMovements(req.valid.query, { skip, limit });
  ok(res, items, meta(total));
}

export async function exportMovements(req, res) {
  const rows = [["date_time", "product", "variant", "sku", "previous_qty", "adjustment", "new_qty", "type", "reason", "note", "updated_by", "order", "return"]];
  for await (const m of await inventory.movementsCursor(req.valid.query, MAX_EXPORT_ROWS)) {
    const v = inventory.movementView(m);
    rows.push([csvDate(v.createdAt), v.product?.name, v.variant, v.sku, v.before ?? "", v.delta, v.after ?? "", v.mode || "automatic", v.reason, v.note,
      v.actor ? `${v.actor.name} <${v.actor.email}>` : "System", v.order?.orderNumber, v.returnRequest?.returnNumber]);
  }
  await audit("inventory.history_exported", { actor: req.auth.user._id, entity: "InventoryMovement", ip: req.ip, meta: { rows: rows.length - 1 } });
  sendCsv(res, `shoponzy-stock-history-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}

/* Stock list (one row per variant) with the same filters as the Inventory pages. */
export async function exportStock(req, res) {
  const { items } = await inventory.listStock({ ...req.valid.query, page: 1, limit: MAX_EXPORT_ROWS });
  const rows = [["product", "variant", "sku", "brand", "category", "product_status", "variant_status", "price", "available_stock", "reserved", "low_stock_alert_at", "alert_level_source", "stock_status", "last_updated"]];
  for (const i of items) {
    rows.push([i.name, [i.color, i.size].filter(Boolean).join(" / "), i.sku, i.brand, i.category?.path || i.category?.name, i.productStatus, i.variantStatus,
      i.price, i.stock, i.reserved, i.threshold, i.productThreshold === null || i.productThreshold === undefined ? "store default" : "product", i.stockStatus, csvDate(i.lastUpdated)]);
  }
  await audit("inventory.stock_exported", { actor: req.auth.user._id, entity: "Product", ip: req.ip, meta: { rows: items.length, filters: req.valid.query } });
  const tag = req.valid.query.stockStatus ? `-${req.valid.query.stockStatus}` : "";
  sendCsv(res, `shoponzy-stock${tag}-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}
