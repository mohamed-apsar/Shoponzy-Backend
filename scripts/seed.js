/* Loads the storefront's current catalogue and content into MongoDB.

   npm run seed                      add anything missing (existing records are left untouched)
   npm run seed -- --upload-images   also copy the real product photos into Cloudinary
   npm run seed -- --force           allow running with NODE_ENV=production

   Source: user-site/src/data/catalog.js (the same data the React storefront ships with).
   ⚠️ Stock levels are SAMPLE values (20 per variant) — the original site had no stock data.
   ⚠️ "From ₹480–₹520" products: sizes 9+ are given the upper price; confirm with the store. */
import { parseArgs } from "node:util";
import { env } from "../src/config/env.js";
import { connectDb, disconnectDb } from "../src/config/db.js";
import { Category } from "../src/models/Category.js";
import { Product } from "../src/models/Product.js";
import { Coupon, InventoryMovement } from "../src/models/commerce.js";
import { Banner, HomepageSection, Page } from "../src/models/site.js";
import { uploadImage } from "../src/services/uploadService.js";
import { slugify } from "../src/utils/slugify.js";
import { CATS, PRODUCTS, HERO_SLIDES, STORE } from "../../user-site/src/data/catalog.js";

export const SAMPLE_STOCK = 20;

const PAGES = [
  ["about", "About Shoponzy", "Who we are.", "Shoponzy brings shoes, sunglasses, perfumes, clothing, watches and everyday essentials together in one easy store, with honest prices and quick delivery."],
  ["shipping-policy", "Shipping policy", "How and when we deliver.", `- Orders are dispatched within 1–2 working days.\n- ${STORE.deliveryText}.\n- Free delivery on orders above ₹${STORE.freeShippingAbove}; a flat ₹${STORE.shippingFee} applies below that.\n- Cash on delivery is available on most PIN codes.`],
  ["return-policy", "Return & refund policy", "7-day returns and exchanges.", "- Return or exchange within 7 days of delivery, for unused items with original tags and packaging.\n- Perfumes, innerwear and items marked non-returnable can’t be returned once opened, for hygiene reasons.\n- Refunds for prepaid orders go back to the original payment method within 5–7 working days after the return is received."],
  ["privacy-policy", "Privacy policy", "What we collect and why.", "We collect only the details needed to process and deliver your order (name, phone, address, email). We don’t sell your data. Guest bags are kept in your browser; if you create an account, your bag, wishlist, addresses and orders are stored with it. You can delete your account at any time from your account page."],
  ["terms", "Terms & conditions", "The terms of using Shoponzy.", "Prices and offers can change without notice. Orders are confirmed once placed and, for online payments, once the payment succeeds. Product colours may vary slightly from screen to screen."],
  ["order-cancellation", "Order cancellation", "Cancelling an order.", "Orders can be cancelled before they are shipped — from your account, or by messaging us your order ID on WhatsApp. Prepaid orders are refunded to the original payment method."],
  ["faqs", "FAQs", "Common questions.", "## How do I place an order?\nAdd items to your bag and check out. Pay online or choose Cash on delivery.\n\n## Is cash on delivery available?\nYes, on most PIN codes. Paying online gets you an extra 5% off.\n\n## How do I find my size?\nTap “Size guide” on any product page. If you’re between sizes, pick the larger one or ask us on WhatsApp."],
];

async function seedCategories() {
  const subIds = new Map();
  let created = 0;
  for (const [i, c] of CATS.entries()) {
    let top = await Category.findOne({ path: c.id });
    if (!top) {
      top = await Category.create({
        name: c.name, slug: c.id, path: c.id, level: 1, parent: null, ancestors: [], order: i + 1,
        display: { tagline: c.tag, color: c.color, gradient: c.gradient, artKind: c.subs[0][2], artColor: c.subs[0][3],
          heroArt: c.heroArt.map(([kind, color]) => ({ kind, color })), bannerArt: { kind: c.bannerArt[0], color: c.bannerArt[1] } },
        seo: { title: `${c.name} Online | Shoponzy`, description: `Shop ${c.name.toLowerCase()} online at Shoponzy. ${c.tag}. Free delivery above ₹999, COD and 7-day returns.`.slice(0, 160) },
      });
      created++;
    }
    for (const [j, [slug, name, kind, color]] of c.subs.entries()) {
      let sub = await Category.findOne({ path: `${c.id}/${slug}` });
      if (!sub) {
        sub = await Category.create({ name, slug, path: `${c.id}/${slug}`, level: 2, parent: top._id, ancestors: [top._id], order: j + 1, display: { artKind: kind, artColor: color } });
        created++;
      }
      subIds.set(`${c.id}/${slug}`, sub);
    }
  }
  return { subIds, created };
}

async function productImages(p, upload) {
  if (!p.images) return [];
  if (!upload) return p.images.map((url, k) => ({ url, publicId: null, alt: k ? `${p.name} view ${k + 1}` : p.name }));
  const out = [];
  for (const [k, url] of p.images.entries()) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download ${url} (${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const up = await uploadImage({ buffer, size: buffer.length }, "product");
    out.push({ url: up.url, publicId: up.publicId, alt: k ? `${p.name} view ${k + 1}` : p.name, width: up.width, height: up.height });
  }
  return out;
}

async function seedProducts(subIds, upload) {
  let created = 0;
  const base = Date.now();
  for (const [i, p] of PRODUCTS.entries()) {
    if (await Product.exists({ legacyId: p.id })) continue;
    const cat = subIds.get(`${p.cat}/${p.sub}`);
    const colors = p.colors.map(([hex, name]) => ({ name, hex }));
    const sizes = p.sizes;
    const priceFor = (size) => (p.from && p.priceTo && Number(size) >= 9 ? p.priceTo : p.price);
    const variants = colors.flatMap((c) => sizes.map((size) => ({
      sku: `${p.id}-${slugify(c.name)}-${slugify(size)}`.toUpperCase(), color: c.name, size,
      price: priceFor(size), mrp: p.mrp > p.price ? p.mrp : 0, stock: SAMPLE_STOCK, status: "active",
    })));
    const product = await Product.create({
      name: p.name, slug: p.slug, sku: p.id, legacyId: p.id, brand: p.brand || "",
      description: p.desc || "", category: cat._id, categoryPath: [...cat.ancestors, cat._id],
      images: await productImages(p, upload), colors, sizes, variants,
      specs: (p.specs || []).map(([label, value]) => ({ label, value })),
      isNewArrival: Boolean(p.isNew), isBestseller: p.badge === "Bestseller", isTrending: p.badge === "Trending", badge: p.badge || "",
      status: "active",
      // Staggered so "featured / newest first" reproduces the original catalogue order.
      createdAt: new Date(base - i * 1000), updatedAt: new Date(base - i * 1000),
    });
    await InventoryMovement.insertMany(product.variants.map((v) => ({ product: product._id, variant: v._id, sku: v.sku, delta: v.stock, reason: "initial", note: "Seed (sample stock)" })));
    created++;
  }
  return created;
}

async function seedContent() {
  const out = {};
  if (!(await Banner.exists({}))) {
    await Banner.insertMany(HERO_SLIDES.map((s, i) => ({
      title: s.title, subtitle: s.text, kicker: s.kick, background: s.bg, art: { kind: s.art[0], color: s.art[1], category: s.art[2] },
      buttonText: s.cta, url: s.href, placement: "hero", order: i + 1, status: "active",
    })));
    out.banners = HERO_SLIDES.length;
  }
  if (!(await HomepageSection.exists({}))) {
    const shoes = await Category.findOne({ path: "shoes" });
    await HomepageSection.insertMany([
      { title: "New arrivals", subtitle: "Fresh drops across every category", source: "new", count: 10, order: 1, buttonText: "View all", url: "/products?sort=new" },
      { title: "Bestsellers", subtitle: "What everyone’s adding to their bag", source: "bestseller", count: 10, order: 2, buttonText: "View all", url: "/products" },
      { title: "Explore categories", type: "categories", source: "categories", count: 6, order: 3, buttonText: "", url: "" },
      { title: "Shoponzy shoes", subtitle: "Sandals, boots and more from our own range", source: "category", category: shoes._id, count: 10, order: 4, buttonText: "View all", url: "/categories/shoes" },
      { title: "Biggest deals", subtitle: "Top discounts right now", source: "deals", layout: "grid", count: 8, order: 5, buttonText: "View all", url: "/products?sale=1" },
    ]);
    out.sections = 5;
  }
  if (!(await Coupon.exists({ code: "WELCOME10" }))) {
    const c = STORE.coupons.WELCOME10;
    await Coupon.create({ code: "WELCOME10", description: c.label, type: "percent", value: c.pct, minSubtotal: c.min, status: "active" });
    out.coupons = 1;
  }
  let pages = 0;
  for (const [slug, title, description, content] of PAGES) {
    if (await Page.exists({ slug })) continue;
    await Page.create({ slug, title, description, content, status: "published", seo: { title: `${title} | Shoponzy`, description } });
    pages++;
  }
  if (pages) out.pages = pages;
  return out;
}

export async function seed({ upload = false } = {}) {
  const { subIds, created: categories } = await seedCategories();
  const products = await seedProducts(subIds, upload);
  const content = await seedContent();
  return { categories, products, ...content };
}

const isCli = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isCli) {
  const { values } = parseArgs({ options: { "upload-images": { type: "boolean", default: false }, force: { type: "boolean", default: false } } });
  if (env.NODE_ENV === "production" && !values.force) {
    console.error("Refusing to seed a production database without --force.");
    process.exit(1);
  }
  await connectDb(env.MONGODB_URI);
  try {
    await Promise.all([Category, Product, Coupon, Page].map((m) => m.syncIndexes()));
    const result = await seed({ upload: values["upload-images"] });
    console.log("Seed complete (new records):", result);
    console.log(`Note: product stock is sample data (${SAMPLE_STOCK} per variant). Update real stock in the admin panel.`);
  } catch (err) {
    console.error("Seed failed:", err.message);
    process.exitCode = 1;
  } finally {
    await disconnectDb();
  }
}
