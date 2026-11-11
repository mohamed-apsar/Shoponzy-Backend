import crypto from "node:crypto";
import { Cart } from "../models/commerce.js";
import { Product } from "../models/Product.js";
import { round2 } from "../models/shared.js";
import { AppError } from "../utils/AppError.js";
import { getSection } from "./settingsService.js";
import { computeTotals, evaluateCoupon } from "./pricingService.js";
import { visibleFilter } from "./catalogService.js";

export const MAX_LINE_QTY = 10;
export const GUEST_CART_COOKIE = "sz_cart";
export const newGuestId = () => crypto.randomBytes(24).toString("base64url");

const ownerQuery = (owner) => (owner.userId ? { user: owner.userId } : { guestId: owner.guestId });

export async function getCart(owner, { create = false } = {}) {
  if (!owner.userId && !owner.guestId) return create ? null : { items: [], couponCode: null };
  let cart = await Cart.findOne(ownerQuery(owner));
  if (!cart && create) cart = await Cart.create(ownerQuery(owner));
  return cart || { items: [], couponCode: null };
}

async function loadVariant(productId, variantId) {
  const product = await Product.findOne({ _id: productId, ...(await visibleFilter()) }).lean();
  const variant = product?.variants.find((v) => String(v._id) === String(variantId) && v.status === "active");
  if (!product || !variant) throw AppError.notFound("This product is no longer available.");
  return { product, variant };
}

export async function addItem(owner, { productId, variantId, qty }) {
  const { variant } = await loadVariant(productId, variantId);
  if (variant.stock < 1) throw new AppError(409, "OUT_OF_STOCK", "Sorry, this size is out of stock.");
  const cart = await getCart(owner, { create: true });
  const line = cart.items.find((i) => String(i.product) === String(productId) && String(i.variant) === String(variantId));
  const wanted = Math.min(MAX_LINE_QTY, (line?.qty || 0) + qty);
  if (wanted > variant.stock) throw new AppError(409, "INSUFFICIENT_STOCK", `Only ${variant.stock} left in this size.`);
  if (line) line.qty = wanted;
  else cart.items.push({ product: productId, variant: variantId, qty: wanted });
  await cart.save();
  return cart;
}

export async function updateItem(owner, itemId, qty) {
  const cart = await getCart(owner);
  const line = cart.items?.find?.((i) => String(i._id) === itemId);
  if (!line) throw AppError.notFound("That item is no longer in your bag.");
  const { variant } = await loadVariant(line.product, line.variant);
  if (qty > variant.stock) throw new AppError(409, "INSUFFICIENT_STOCK", `Only ${variant.stock} left in this size.`);
  line.qty = qty;
  await cart.save();
  return cart;
}

export async function removeItem(owner, itemId) {
  const cart = await getCart(owner);
  if (cart.items?.length) {
    cart.items = cart.items.filter((i) => String(i._id) !== itemId);
    await cart.save();
  }
  return cart;
}

export async function setCoupon(owner, code) {
  const cart = await getCart(owner, { create: true });
  if (code) {
    const priced = await priceCart({ ...cart.toObject(), couponCode: null }, { paymentMethod: "cod", userId: owner.userId });
    const result = await evaluateCoupon(code, priced.totals.cod.subtotal, { userId: owner.userId });
    // Valid-but-below-minimum codes are kept (the bag shows "add ₹X more"); unknown/expired ones are rejected.
    if (result.error && !result.belowMinimum) throw new AppError(400, "INVALID_COUPON", result.error);
    cart.couponCode = result.coupon.code;
  } else cart.couponCode = null;
  await cart.save();
  return cart;
}

/* Guest bag → account bag after sign-in. Quantities add up, capped at the line maximum. */
export async function mergeGuestCart(guestId, userId) {
  if (!guestId) return;
  const guest = await Cart.findOne({ guestId });
  if (!guest) return;
  const cart = await getCart({ userId }, { create: true });
  for (const item of guest.items) {
    const line = cart.items.find((i) => String(i.product) === String(item.product) && String(i.variant) === String(item.variant));
    if (line) line.qty = Math.min(MAX_LINE_QTY, line.qty + item.qty);
    else cart.items.push({ product: item.product, variant: item.variant, qty: item.qty });
  }
  if (!cart.couponCode && guest.couponCode) cart.couponCode = guest.couponCode;
  await cart.save();
  await guest.deleteOne();
}

/* Prices a cart from current database values. Every line reports whether it can be bought now. */
export async function priceCart(cart, { userId, phone } = {}) {
  const ids = [...new Set(cart.items.map((i) => String(i.product)))];
  const products = await Product.find({ _id: { $in: ids }, ...(await visibleFilter()) }).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const commerce = await getSection("commerce");
  const general = await getSection("general");

  const lines = cart.items.map((i) => {
    const p = byId.get(String(i.product));
    const v = p?.variants.find((x) => String(x._id) === String(i.variant) && x.status === "active");
    if (!p || !v) return { itemId: String(i._id), qty: i.qty, available: false, issue: "unavailable", message: "No longer available" };
    const issue = v.stock < 1 ? "out_of_stock" : v.stock < i.qty ? "insufficient_stock" : null;
    return {
      itemId: String(i._id), productId: String(p._id), variantId: String(v._id), slug: p.slug, name: p.name, brand: p.brand,
      image: p.images[0]?.url || null, color: v.color, colorHex: p.colors.find((c) => c.name === v.color)?.hex || null, size: v.size,
      sku: v.sku, price: v.price, mrp: Math.max(v.mrp || 0, v.price), qty: i.qty, lineTotal: round2(v.price * i.qty),
      available: !issue, issue, maxQty: Math.min(MAX_LINE_QTY, v.stock),
      message: issue === "out_of_stock" ? "Out of stock" : issue === "insufficient_stock" ? `Only ${v.stock} left` : null,
      // For the storefront's illustration fallback when a product has no photos.
      category: String(p.category), categoryPath: p.categoryPath.map(String),
    };
  });

  const buyable = lines.filter((l) => l.available);
  const subtotal = round2(buyable.reduce((s, l) => s + l.lineTotal, 0));
  const mrpTotal = round2(buyable.reduce((s, l) => s + l.mrp * l.qty, 0));
  const c = await evaluateCoupon(cart.couponCode, subtotal, { userId, phone });
  const base = { subtotal, mrpTotal, couponDiscount: c.discount, commerce, taxRate: general.taxRate || 0 };
  return {
    lines,
    itemCount: lines.reduce((s, l) => s + l.qty, 0),
    hasIssues: lines.some((l) => !l.available),
    coupon: cart.couponCode ? { code: cart.couponCode, applied: c.discount > 0, message: c.error || `${cart.couponCode} applied` } : null,
    totals: { cod: computeTotals({ ...base, paymentMethod: "cod" }), razorpay: computeTotals({ ...base, paymentMethod: "razorpay" }) },
    commerce: { freeShippingAbove: commerce.freeShippingAbove, shippingFee: commerce.shippingFee, prepaidOffPct: commerce.prepaidOffPct, codEnabled: commerce.codEnabled, codMaxOrderValue: commerce.codMaxOrderValue },
  };
}
