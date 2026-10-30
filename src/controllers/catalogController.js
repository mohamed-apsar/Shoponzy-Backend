import { Product } from "../models/Product.js";
import { Category } from "../models/Category.js";
import * as catalog from "../services/catalogService.js";
import { publicCategory, publicTree } from "../services/categoryService.js";
import { AppError } from "../utils/AppError.js";
import { ok } from "../utils/respond.js";

export const categoryTree = async (_req, res) => ok(res, await publicTree());

export async function categoryByPath(req, res) {
  const path = String(req.params.path || "").toLowerCase();
  const cat = await Category.findOne({ path, status: "enabled" }).lean();
  if (!cat) throw AppError.notFound("Category not found.");
  const children = await Category.find({ parent: cat._id, status: "enabled" }).sort({ order: 1, name: 1 }).lean();
  ok(res, { ...publicCategory(cat), children: children.map(publicCategory) });
}

export async function listProducts(req, res) {
  const { items, meta, ...extra } = await catalog.listProducts(req.valid.query);
  res.json({ success: true, data: items, meta, ...extra });
}

export const productBySlug = async (req, res) => ok(res, await catalog.getProductBySlug(String(req.params.slug).toLowerCase()));

export const relatedProducts = async (req, res) => ok(res, await catalog.relatedProducts(req.params.id));

export const productsByIds = async (req, res) => ok(res, await catalog.productsByIds(req.valid.query.ids));

/* Maps ids from the original static site (product.html?id=SH-101) to the new slug, for redirects. */
export async function legacyLookup(req, res) {
  const p = await Product.findOne({ legacyId: String(req.params.legacyId).slice(0, 40), status: "active" }).select("slug").lean();
  if (!p) throw AppError.notFound("Product not found.");
  ok(res, { slug: p.slug });
}
