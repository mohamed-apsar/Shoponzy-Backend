import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { API, app, useDb } from "./helpers.js";
import { adminBrowser, category, mockCloudinary, simpleProduct, sneaker, variantOf } from "./fixtures.js";
import { Category } from "../src/models/Category.js";
import { Product } from "../src/models/Product.js";
import { InventoryMovement, Order } from "../src/models/commerce.js";

useDb();
let admin;
beforeEach(async () => { admin = await adminBrowser(); });

describe("admin categories", () => {
  it("creates a 5-level hierarchy with paths, and refuses a 6th level", async () => {
    let parent = null;
    const names = ["Clothing", "Pants", "Jeans", "Casual", "Slim Fit"];
    for (const name of names) {
      const res = await admin.post("/admin/categories", { name, slug: name.toLowerCase().replace(" ", "-"), parent: parent?.id }).expect(201);
      parent = res.body.data;
    }
    expect(parent).toMatchObject({ level: 5, path: "clothing/pants/jeans/casual/slim-fit" });
    const res = await admin.post("/admin/categories", { name: "Too Deep", slug: "too-deep", parent: parent.id }).expect(400);
    expect(res.body.error.message).toMatch(/at most 5 levels/);
  });

  it("lists by level with parent path names and product counts", async () => {
    await sneaker();
    const res = await admin.get("/admin/categories?level=2").expect(200);
    expect(res.body.data[0]).toMatchObject({ name: "Sneakers", pathNames: "Shoes", productCount: 1, level: 2 });
  });

  it("rejects duplicate slugs under the same parent but allows them under different parents", async () => {
    const a = await category("Shirts"), b = await category("Pants");
    await admin.post("/admin/categories", { name: "Casual", slug: "casual", parent: String(a._id) }).expect(201);
    await admin.post("/admin/categories", { name: "Casual", slug: "casual", parent: String(b._id) }).expect(201);
    await admin.post("/admin/categories", { name: "Casual 2", slug: "casual", parent: String(a._id) }).expect(409);
  });

  it("prevents moving a category under itself or its own descendant", async () => {
    const top = await category("Clothing"), mid = await category("Pants", top), leaf = await category("Jeans", mid);
    await admin.patch(`/admin/categories/${top._id}`, { parent: String(leaf._id) }).expect(400);
    await admin.patch(`/admin/categories/${top._id}`, { parent: String(top._id) }).expect(400);
  });

  it("moving or renaming a branch updates descendant paths and product category paths", async () => {
    const shoes = await category("Shoes"), sneakers = await category("Sneakers", shoes), running = await category("Running", sneakers);
    const p = await simpleProduct({ categoryName: "Shoes" });
    await Product.updateOne({ _id: p._id }, { category: running._id, categoryPath: [shoes._id, sneakers._id, running._id] });
    const footwear = await category("Footwear");

    await admin.patch(`/admin/categories/${sneakers._id}`, { parent: String(footwear._id), slug: "trainers" }).expect(200);
    const moved = await Category.findById(running._id);
    expect(moved.path).toBe("footwear/trainers/running");
    expect(moved.ancestors.map(String)).toEqual([String(footwear._id), String(sneakers._id)]);
    expect((await Product.findById(p._id)).categoryPath.map(String)).toEqual([String(footwear._id), String(sneakers._id), String(running._id)]);
  });

  it("won't delete a category that has subcategories or products", async () => {
    const p = await sneaker();
    const shoes = await Category.findOne({ path: "shoes" }), sneakers = await Category.findOne({ path: "shoes/sneakers" });
    expect((await admin.del(`/admin/categories/${shoes._id}`).expect(409)).body.error.message).toMatch(/subcategor/);
    expect((await admin.del(`/admin/categories/${sneakers._id}`).expect(409)).body.error.message).toMatch(/1 product is/);
    await Product.deleteOne({ _id: p._id });
    await admin.del(`/admin/categories/${sneakers._id}`).expect(200);
  });
});

describe("admin products", () => {
  it("creates a product with a colour × size variant matrix and derived price/stock", async () => {
    const sneakers = await category("Sneakers", await category("Shoes"));
    const res = await admin.post("/admin/products", {
      name: "Runner Pro", category: String(sneakers._id), brand: "Shoponzy",
      colors: [{ name: "Red", hex: "#FF0000" }], sizes: ["8", "9"],
      variants: [{ color: "Red", size: "8", price: 1499, mrp: 2999, stock: 3, sku: "RP-R-8" }, { color: "Red", size: "9", price: 1599, mrp: 2999, stock: 0, sku: "RP-R-9" }],
    }).expect(201);
    expect(res.body.data).toMatchObject({ slug: "runner-pro", minPrice: 1499, maxPrice: 1599, mrp: 2999, discountPct: 50, totalStock: 3 });
    expect(await InventoryMovement.countDocuments({ reason: "initial" })).toBe(1);
  });

  it("validates variants against declared colours/sizes, duplicates, MRP and SKU uniqueness", async () => {
    const cat = await category("Shoes");
    const base = { name: "Bad", category: String(cat._id), colors: [{ name: "Red", hex: "#FF0000" }], sizes: ["8"] };
    await admin.post("/admin/products", { ...base, variants: [{ color: "Blue", size: "8", price: 1, stock: 1 }] }).expect(400);
    await admin.post("/admin/products", { ...base, variants: [{ color: "Red", size: "8", price: 1, stock: 1 }, { color: "Red", size: "8", price: 1, stock: 1 }] }).expect(400);
    await admin.post("/admin/products", { ...base, variants: [{ color: "Red", size: "8", price: 100, mrp: 50, stock: 1 }] }).expect(400);
    await admin.post("/admin/products", { name: "Neg", category: String(cat._id), price: -5 }).expect(400);
    await admin.post("/admin/products", { name: "Item A", category: String(cat._id), price: 10, sku: "DUP" }).expect(201);
    await admin.post("/admin/products", { name: "Item B", category: String(cat._id), price: 10, sku: "DUP" }).expect(409);
  });

  it("simple products: editing price keeps stock; multi-variant products refuse a bare price", async () => {
    const wallet = await simpleProduct({ stock: 7 });
    const res = await admin.patch(`/admin/products/${wallet._id}`, { price: 650 }).expect(200);
    expect(res.body.data.variants[0]).toMatchObject({ price: 650, stock: 7, id: String(wallet.variants[0]._id) });
    const s = await sneaker();
    await admin.patch(`/admin/products/${s._id}`, { price: 900 }).expect(400);
  });

  it("keeps variant ids when the matrix is re-sent, and logs manual stock edits", async () => {
    const s = await sneaker();
    const white7 = variantOf(s, "White", "7");
    const variants = s.variants.map((v) => ({ color: v.color, size: v.size, price: v.price, mrp: v.mrp, stock: v.color === "White" && v.size === "7" ? 12 : v.stock }));
    const res = await admin.patch(`/admin/products/${s._id}`, { variants }).expect(200);
    expect(variantOf(res.body.data, "White", "7")).toMatchObject({ id: String(white7._id), stock: 12 });
    expect(await InventoryMovement.findOne({ reason: "adjustment" })).toMatchObject({ delta: 7 });
  });

  it("gives slugs a numeric suffix when taken", async () => {
    const cat = await category("Shoes");
    await admin.post("/admin/products", { name: "Same Name", category: String(cat._id), price: 1 }).expect(201);
    expect((await admin.post("/admin/products", { name: "Same Name", category: String(cat._id), price: 1 }).expect(201)).body.data.slug).toBe("same-name-2");
  });

  it("only accepts images uploaded through the upload endpoint", async () => {
    const cat = await category("Shoes");
    await admin.post("/admin/products", { name: "X", category: String(cat._id), price: 1, images: [{ url: "https://evil.example/x.jpg", publicId: "shoponzy/products/fake" }] }).expect(400);
    await admin.post("/admin/products", { name: "Y", category: String(cat._id), price: 1, images: [{ url: "https://evil.example/x.jpg" }] }).expect(400);
  });

  it("stores, serves and releases product SEO metadata and its image", async () => {
    const { destroyed } = mockCloudinary();
    const jpeg = Buffer.concat([Buffer.from("ffd8ffe000104a4649460001", "hex"), Buffer.alloc(100)]);
    const image = (await admin.agent.post(`${API}/admin/uploads`).set("X-CSRF-Token", admin.token)
      .field("kind", "seo").attach("file", jpeg, "product-meta.jpg").expect(201)).body.data;
    const cat = await category("Shoes");
    const robots = "index, nofollow, max-snippet:120, max-video-preview:0, max-image-preview:large";
    const created = await admin.post("/admin/products", {
      name: "SEO Product", category: String(cat._id), price: 100,
      seo: { title: "SEO Product title", description: "Search description", image, robots },
    }).expect(201);
    expect(created.body.data.seo).toMatchObject({
      title: "SEO Product title", description: "Search description", image: { publicId: image.publicId }, robots,
    });

    const detail = await request(app).get(`${API}/products/${created.body.data.slug}`).expect(200);
    expect(detail.body.data.seo).toMatchObject({
      title: "SEO Product title", description: "Search description", image: { url: image.url }, robots,
    });
    await admin.patch(`/admin/products/${created.body.data.id}`, { seo: { title: "Updated product title" } }).expect(200);
    expect((await admin.get(`/admin/products/${created.body.data.id}`).expect(200)).body.data.seo).toMatchObject({
      title: "Updated product title", image: { publicId: image.publicId }, robots,
    });
    await admin.patch(`/admin/products/${created.body.data.id}`, { seo: { image: null } }).expect(200);
    expect(destroyed).toEqual([image.publicId]);
    await admin.patch(`/admin/products/${created.body.data.id}`, { seo: { robots: "index, unsafe" } }).expect(400);
  });

  it("stores and releases featured and gallery images for each product colour", async () => {
    const { destroyed } = mockCloudinary();
    const jpeg = Buffer.concat([Buffer.from("ffd8ffe000104a4649460001", "hex"), Buffer.alloc(100)]);
    const upload = async (name) => (await admin.agent.post(`${API}/admin/uploads`)
      .set("X-CSRF-Token", admin.token).field("kind", "product").attach("file", jpeg, name).expect(201)).body.data;
    const featured = await upload("black-feature.jpg");
    const gallery = await upload("black-gallery.jpg");
    const cat = await category("Shoes");
    const created = await admin.post("/admin/products", {
      name: "Image Variants", category: String(cat._id), sizes: ["7"],
      colors: [{ name: "Black", hex: "#111111", featuredImage: featured, images: [gallery] }],
      variants: [{ color: "Black", size: "7", price: 100, stock: 2 }],
    }).expect(201);
    expect(created.body.data.colors[0]).toMatchObject({
      name: "Black",
      featuredImage: { publicId: featured.publicId },
      images: [expect.objectContaining({ publicId: gallery.publicId })],
    });
    const storefront = await request(app).get(`${API}/products/${created.body.data.slug}`).expect(200);
    expect(storefront.body.data.colors[0]).toMatchObject({
      featuredImage: { url: featured.url },
      images: [expect.objectContaining({ url: gallery.url })],
    });

    await admin.patch(`/admin/products/${created.body.data.id}`, {
      colors: [{ name: "Black", hex: "#111111", featuredImage: gallery, images: [] }],
    }).expect(200);
    expect(destroyed).toEqual([featured.publicId]);

    await admin.del(`/admin/products/${created.body.data.id}`).expect(200);
    expect(destroyed).toEqual([featured.publicId, gallery.publicId]);
  });

  it("stores ordered product banners and image rows, exposes them on detail, and releases replaced images", async () => {
    const { destroyed } = mockCloudinary();
    const jpeg = Buffer.concat([Buffer.from("ffd8ffe000104a4649460001", "hex"), Buffer.alloc(100)]);
    const upload = async (name) => (await admin.agent.post(`${API}/admin/uploads`)
      .set("X-CSRF-Token", admin.token).field("kind", "product").attach("file", jpeg, name).expect(201)).body.data;
    const banner = await upload("detail-banner.jpg");
    const rowImages = await Promise.all(["office.jpg", "date.jpg", "party.jpg"].map(upload));
    const replacement = await upload("updated-banner.jpg");
    const cat = await category("Shoes");
    const created = await admin.post("/admin/products", {
      name: "Product Story", category: String(cat._id), price: 100,
      contentBlocks: [
        { type: "banner", image: banner },
        { type: "imageRow", images: rowImages },
      ],
    }).expect(201);
    expect(created.body.data.contentBlocks).toMatchObject([
      { type: "banner", image: { publicId: banner.publicId } },
      { type: "imageRow", images: rowImages.map((image) => expect.objectContaining({ publicId: image.publicId })) },
    ]);

    const detail = await request(app).get(`${API}/products/${created.body.data.slug}`).expect(200);
    expect(detail.body.data.contentBlocks).toMatchObject([
      { type: "banner", image: { url: banner.url } },
      { type: "imageRow", images: rowImages.map((image) => expect.objectContaining({ url: image.url })) },
    ]);
    expect((await request(app).get(`${API}/products`).expect(200)).body.data[0]).not.toHaveProperty("contentBlocks");

    await admin.patch(`/admin/products/${created.body.data.id}`, {
      contentBlocks: [
        { type: "banner", image: replacement },
        { type: "imageRow", images: rowImages },
      ],
    }).expect(200);
    expect(destroyed).toEqual([banner.publicId]);

    await admin.del(`/admin/products/${created.body.data.id}`).expect(200);
    expect(destroyed).toEqual([banner.publicId, replacement.publicId, ...rowImages.map((image) => image.publicId)]);
  });

  it("requires exactly three uploaded images for each product image row", async () => {
    const cat = await category("Shoes");
    await admin.post("/admin/products", {
      name: "Incomplete Story", category: String(cat._id), price: 100,
      contentBlocks: [{ type: "imageRow", images: [] }],
    }).expect(400);
  });

  it("archives (not deletes) products that appear in orders", async () => {
    const used = await simpleProduct({ name: "Used" }), unused = await simpleProduct({ name: "Unused" });
    await Order.create({ orderNumber: "SZ100001", contact: { name: "A", phone: "9876543210" }, items: [{ product: used._id, qty: 1 }], total: 1, paymentMethod: "cod", status: "placed" });
    expect((await admin.del(`/admin/products/${used._id}`).expect(200)).body.data).toEqual({ deleted: false, archived: true });
    expect((await Product.findById(used._id)).status).toBe("archived");
    expect((await admin.del(`/admin/products/${unused._id}`).expect(200)).body.data.deleted).toBe(true);
    expect(await Product.exists({ _id: unused._id })).toBeNull();
  });

  it("adjusts stock atomically, refusing to go below zero, and records the movement", async () => {
    const s = await sneaker({ stock: 2 });
    const v = variantOf(s, "Black", "9");
    await admin.post(`/admin/products/${s._id}/stock`, { variantId: String(v._id), delta: -3, note: "Shrinkage" }).expect(409);
    // A written reason is required for every manual change.
    await admin.post(`/admin/products/${s._id}/stock`, { variantId: String(v._id), delta: 1 }).expect(400);
    const res = await admin.post(`/admin/products/${s._id}/stock`, { variantId: String(v._id), set: 10, reason: "restock", note: "Shipment" }).expect(200);
    expect(variantOf(res.body.data, "Black", "9").stock).toBe(10);
    expect(res.body.data.totalStock).toBe(2 * 6 + 8);
    expect(await InventoryMovement.findOne({ reason: "restock" })).toMatchObject({ delta: 8, note: "Shipment", before: 2, after: 10, mode: "set" });
  });

  it("lists with search, stock filters and status summary; bulk-updates; exports CSV", async () => {
    await sneaker({ name: "Alpha Runner", stock: 20 });
    await simpleProduct({ name: "Zero Stock", stock: 0 });
    await simpleProduct({ name: "Low Stock", stock: 2 });
    expect((await admin.get("/admin/products?q=alpha").expect(200)).body.meta.total).toBe(1);
    expect((await admin.get("/admin/products?stock=out").expect(200)).body.data.map((p) => p.name)).toEqual(["Zero Stock"]);
    expect((await admin.get("/admin/products?stock=low").expect(200)).body.data.map((p) => p.name)).toEqual(["Low Stock"]);
    const ids = (await Product.find()).map((p) => String(p._id));
    expect((await admin.post("/admin/products/bulk", { ids, action: "disable" }).expect(200)).body.data.succeeded).toBe(3);
    const csv = await admin.get("/admin/products/export.csv").expect(200).expect("content-type", /text\/csv/);
    expect(csv.text.split("\n")).toHaveLength(1 + 6 + 1 + 1);
  });
});

describe("public catalogue", () => {
  it("lists active products with filters, sorting, facets and pagination", async () => {
    await sneaker({ name: "Cheap Sneaker", price: 500, mrp: 1000 });
    await sneaker({ name: "Pricey Sneaker", price: 3000, mrp: 0 });
    await simpleProduct({ name: "Wallet", price: 800 });
    const res = await request(app).get(`${API}/products?category=shoes&sort=low`).expect(200);
    expect(res.body.data.map((p) => p.name)).toEqual(["Cheap Sneaker", "Pricey Sneaker"]);
    expect(res.body.category).toMatchObject({ name: "Shoes", path: "shoes" });
    expect(res.body.facets.subcategories).toEqual([expect.objectContaining({ slug: "sneakers", count: 2 })]);
    expect(res.body.facets.sizes.map((s) => s.value)).toEqual(["7", "8", "9"]);
    expect(res.body.facets.colors.map((c) => c.name).sort()).toEqual(["Black", "White"]);

    expect((await request(app).get(`${API}/products?sale=1`).expect(200)).body.data.map((p) => p.name)).toEqual(["Cheap Sneaker"]);
    expect((await request(app).get(`${API}/products?maxPrice=900`).expect(200)).body.meta.total).toBe(2);
    expect((await request(app).get(`${API}/products?q=wall`).expect(200)).body.data[0].name).toBe("Wallet");
    expect((await request(app).get(`${API}/products?q=black`).expect(200)).body.meta.total).toBe(2); // colour names match
    expect((await request(app).get(`${API}/products?q=shoes`).expect(200)).body.meta.total).toBe(2); // category names match
    const page = (await request(app).get(`${API}/products?limit=1&page=2&sort=high`).expect(200)).body;
    expect(page.meta).toMatchObject({ page: 2, limit: 1, total: 3, pages: 3 });
  });

  it("hides disabled/archived products and everything in a disabled category branch", async () => {
    const s = await sneaker({ name: "Visible" });
    await simpleProduct({ name: "Disabled", status: "disabled" });
    expect((await request(app).get(`${API}/products`).expect(200)).body.data.map((p) => p.name)).toEqual(["Visible"]);
    await Category.updateOne({ path: "shoes" }, { status: "disabled" });
    expect((await request(app).get(`${API}/products`).expect(200)).body.meta.total).toBe(0);
    await request(app).get(`${API}/products/${s.slug}`).expect(404);
    await request(app).get(`${API}/products?category=shoes/sneakers`).expect(404);
    expect((await request(app).get(`${API}/categories`).expect(200)).body.data.map((c) => c.name)).toEqual(["Essentials"]);
  });

  it("product detail exposes availability but not exact stock above the low-stock threshold", async () => {
    const s = await sneaker({ stock: 50 });
    await Product.updateOne({ _id: s._id, "variants._id": variantOf(s, "White", "7")._id }, { $set: { "variants.$.stock": 2 } });
    await Product.updateOne({ _id: s._id, "variants._id": variantOf(s, "White", "8")._id }, { $set: { "variants.$.stock": 0 } });
    const p = (await request(app).get(`${API}/products/${s.slug}`).expect(200)).body.data;
    expect(p.variants.find((v) => v.size === "7" && v.color === "White")).toMatchObject({ inStock: true, stockLeft: 2 });
    expect(p.variants.find((v) => v.size === "8" && v.color === "White")).toMatchObject({ inStock: false, stockLeft: null });
    expect(p.variants.find((v) => v.size === "9" && v.color === "White")).toMatchObject({ inStock: true, stockLeft: null });
    expect(JSON.stringify(p)).not.toContain('"stock"');
    expect(p.category).toMatchObject({ name: "Sneakers", path: "shoes/sneakers" });
  });

  it("returns the category tree, related products, products by ids and legacy-id lookups", async () => {
    const a = await sneaker({ name: "A" }), b = await sneaker({ name: "B" });
    await Product.updateOne({ _id: a._id }, { legacyId: "SH-101" });
    const tree = (await request(app).get(`${API}/categories`).expect(200)).body.data;
    expect(tree[0]).toMatchObject({ name: "Shoes", children: [expect.objectContaining({ name: "Sneakers", path: "shoes/sneakers" })] });
    expect((await request(app).get(`${API}/categories/shoes/sneakers`).expect(200)).body.data.name).toBe("Sneakers");
    expect((await request(app).get(`${API}/products/${a._id}/related`).expect(200)).body.data.map((p) => p.name)).toEqual(["B"]);
    expect((await request(app).get(`${API}/products/by-ids?ids=${b._id},${a._id}`).expect(200)).body.data.map((p) => p.name)).toEqual(["B", "A"]);
    expect((await request(app).get(`${API}/products/legacy/SH-101`).expect(200)).body.data.slug).toBe(a.slug);
  });
});

describe("uploads (Cloudinary mocked)", () => {
  const JPEG = Buffer.concat([Buffer.from("ffd8ffe000104a4649460001", "hex"), Buffer.alloc(100)]);
  const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d", "hex"), Buffer.alloc(100)]);

  it("uploads, attaches to a category, and deletes the old image when replaced", async () => {
    const { destroyed } = mockCloudinary();
    const up1 = (await admin.agent.post(`${API}/admin/uploads`).set("X-CSRF-Token", admin.token).field("kind", "category").attach("file", JPEG, "a.jpg").expect(201)).body.data;
    expect(up1.publicId).toMatch(/^shoponzy\/categories\//);
    const cat = (await admin.post("/admin/categories", { name: "Bags", slug: "bags", image: up1 }).expect(201)).body.data;
    expect(cat.image.url).toBe(up1.url);
    const up2 = (await admin.agent.post(`${API}/admin/uploads`).set("X-CSRF-Token", admin.token).field("kind", "category").attach("file", PNG, "b.png").expect(201)).body.data;
    await admin.patch(`/admin/categories/${cat.id}`, { image: up2 }).expect(200);
    expect(destroyed).toEqual([up1.publicId]);
  });

  it("saves category page banners and subcategory circle images", async () => {
    const { destroyed } = mockCloudinary();
    const upload = async (name) => (await admin.agent.post(`${API}/admin/uploads`).set("X-CSRF-Token", admin.token)
      .field("kind", "category").attach("file", JPEG, name).expect(201)).body.data;
    const banner = await upload("banner.jpg");
    const explore = await upload("explore.jpg");
    const circle = await upload("subcategory.jpg");
    const shoes = (await admin.post("/admin/categories", {
      name: "Shoes", slug: "shoes", bannerImage: banner, exploreImage: explore,
    }).expect(201)).body.data;
    const sneakers = (await admin.post("/admin/categories", {
      name: "Sneakers", slug: "sneakers", parent: shoes.id, image: circle,
    }).expect(201)).body.data;

    expect(shoes.bannerImage.url).toBe(banner.url);
    expect(shoes.exploreImage.url).toBe(explore.url);
    expect(sneakers.image.url).toBe(circle.url);
    const publicTree = (await request(app).get(`${API}/categories`).expect(200)).body.data;
    expect(publicTree[0].bannerImage.url).toBe(banner.url);
    expect(publicTree[0].exploreImage.url).toBe(explore.url);
    expect(publicTree[0].children[0].image.url).toBe(circle.url);

    await admin.patch(`/admin/categories/${shoes.id}`, { bannerImage: null, exploreImage: null }).expect(200);
    expect(destroyed).toContain(banner.publicId);
    expect(destroyed).toContain(explore.publicId);
  });

  it("keeps three subcategory gallery images and a banner independent per subcategory", async () => {
    const { destroyed } = mockCloudinary();
    const upload = async (kind) => (await admin.agent.post(`${API}/admin/uploads`).set("X-CSRF-Token", admin.token)
      .field("kind", kind).attach("file", JPEG, "a.jpg").expect(201)).body.data;
    const [img1, img2, img3, banner] = [await upload("subcategoryImage1"), await upload("subcategoryImage2"), await upload("subcategoryImage3"), await upload("subcategoryBanner")];
    expect(img1.publicId).toMatch(/^shoponzy\/categories\/subcategory-images\/image-1\//);
    expect(img3.publicId).toMatch(/^shoponzy\/categories\/subcategory-images\/image-3\//);
    expect(banner.publicId).toMatch(/^shoponzy\/categories\/subcategory-banners\//);

    const shoes = (await admin.post("/admin/categories", { name: "Shoes", slug: "shoes" }).expect(201)).body.data;
    const sneakers = (await admin.post("/admin/categories", {
      name: "Sneakers", slug: "sneakers", parent: shoes.id, bannerImage: banner, images: { image1: img1, image2: img2, image3: img3 },
    }).expect(201)).body.data;
    const slides = (await admin.post("/admin/categories", { name: "Slides", slug: "slides", parent: shoes.id }).expect(201)).body.data;
    expect(sneakers.images.image2.url).toBe(img2.url);
    expect(slides.images).toEqual({ image1: null, image2: null, image3: null });

    // Replacing slot 2 leaves slots 1 and 3 and the banner untouched; only the old slot-2 asset is released.
    const img2b = await upload("subcategoryImage2");
    const patched = (await admin.patch(`/admin/categories/${sneakers.id}`, { images: { image2: img2b } }).expect(200)).body.data;
    expect(patched.images.image1.url).toBe(img1.url);
    expect(patched.images.image2.url).toBe(img2b.url);
    expect(patched.images.image3.url).toBe(img3.url);
    expect(patched.bannerImage.url).toBe(banner.url);
    expect(destroyed).toEqual([img2.publicId]);

    // Removing slot 3 only.
    const removed = (await admin.patch(`/admin/categories/${sneakers.id}`, { images: { image3: null } }).expect(200)).body.data;
    expect(removed.images.image3).toBeNull();
    expect(removed.images.image1.url).toBe(img1.url);
    expect(destroyed).toEqual([img2.publicId, img3.publicId]);

    const tree = (await request(app).get(`${API}/categories`).expect(200)).body.data;
    const subs = tree.find((c) => c.slug === "shoes").children;
    const servedSneakers = subs.find((c) => c.slug === "sneakers");
    expect(servedSneakers.images.image1.url).toBe(img1.url);
    expect(servedSneakers.images.image3).toBeNull();
    expect(servedSneakers.bannerImage.url).toBe(banner.url);
    expect(subs.find((c) => c.slug === "slides").bannerImage).toBeNull();

    await admin.post("/admin/categories", { name: "X", slug: "x", images: { image4: img1 } }).expect(400);

    await admin.del(`/admin/categories/${sneakers.id}`).expect(200);
    expect(destroyed).toEqual(expect.arrayContaining([img1.publicId, img2b.publicId, banner.publicId]));
  });

  it("stores, serves, replaces, and deletes a category Shop all background image", async () => {
    const { destroyed } = mockCloudinary();
    const upload = (file, name) => admin.agent.post(`${API}/admin/uploads`)
      .set("X-CSRF-Token", admin.token)
      .field("kind", "category")
      .attach("file", file, name)
      .expect(201)
      .then((response) => response.body.data);
    const first = await upload(JPEG, "explore.jpg");
    const category = (await admin.post("/admin/categories", {
      name: "Explore bags",
      slug: "explore-bags",
      exploreImage: first,
    }).expect(201)).body.data;

    expect(category.exploreImage.url).toBe(first.url);
    const publicTree = (await request(app).get(`${API}/categories`).expect(200)).body.data;
    expect(publicTree.find((item) => item.slug === category.slug).exploreImage.url).toBe(first.url);

    const replacement = await upload(PNG, "explore-replacement.png");
    await admin.patch(`/admin/categories/${category.id}`, { exploreImage: replacement }).expect(200);
    expect(destroyed).toEqual([first.publicId]);

    await admin.del(`/admin/categories/${category.id}`).expect(200);
    expect(destroyed).toEqual([first.publicId, replacement.publicId]);
  });

  it("serves and deletes category page banners and subcategory circle images", async () => {
    const { destroyed } = mockCloudinary();
    const upload = async (file, name) => (await admin.agent.post(`${API}/admin/uploads`)
      .set("X-CSRF-Token", admin.token)
      .field("kind", "category")
      .attach("file", file, name)
      .expect(201)).body.data;
    const banner = await upload(JPEG, "category-banner.jpg");
    const allCircle = await upload(PNG, "all-circle.png");
    const subCircle = await upload(JPEG, "subcategory-circle.jpg");
    const parent = (await admin.post("/admin/categories", {
      name: "Perfumes",
      slug: "perfumes",
    }).expect(201)).body.data;
    const child = (await admin.post("/admin/categories", {
      name: "Eau de Parfum",
      slug: "eau-de-parfum",
      parent: parent.id,
    }).expect(201)).body.data;

    await admin.patch(`/admin/categories/${parent.id}`, {
      bannerImage: banner,
      image: allCircle,
    }).expect(200);
    await admin.patch(`/admin/categories/${child.id}`, { image: subCircle }).expect(200);

    const publicTree = (await request(app).get(`${API}/categories`).expect(200)).body.data;
    const publicParent = publicTree.find((item) => item.slug === "perfumes");
    expect(publicParent.bannerImage.url).toBe(banner.url);
    expect(publicParent.image.url).toBe(allCircle.url);
    expect(publicParent.children[0].image.url).toBe(subCircle.url);
    const listing = await request(app).get(`${API}/products?category=perfumes&limit=1`).expect(200);
    expect(listing.body.category.bannerImage.url).toBe(banner.url);

    await admin.del(`/admin/categories/${child.id}`).expect(200);
    await admin.del(`/admin/categories/${parent.id}`).expect(200);
    expect(destroyed).toHaveLength(3);
    expect(destroyed).toEqual(expect.arrayContaining([banner.publicId, allCircle.publicId, subCircle.publicId]));
  });

  it("saves and removes product images on child categories", async () => {
    const { destroyed } = mockCloudinary();
    const productImage = (await admin.agent.post(`${API}/admin/uploads`).set("X-CSRF-Token", admin.token)
      .field("kind", "product").attach("file", JPEG, "child-product.jpg").expect(201)).body.data;
    const shoes = (await admin.post("/admin/categories", { name: "Shoes", slug: "shoes" }).expect(201)).body.data;
    const casual = (await admin.post("/admin/categories", {
      name: "Casual", slug: "casual", parent: shoes.id,
    }).expect(201)).body.data;
    const child = (await admin.post("/admin/categories", {
      name: "Loafers", slug: "loafers", parent: casual.id, productImage,
    }).expect(201)).body.data;

    expect(child.productImage.url).toBe(productImage.url);
    const publicTree = (await request(app).get(`${API}/categories`).expect(200)).body.data;
    expect(publicTree[0].children[0].children[0].productImage.url).toBe(productImage.url);

    await admin.patch(`/admin/categories/${child.id}`, { productImage: null }).expect(200);
    expect(destroyed).toContain(productImage.publicId);
  });

  it("keeps an image that another record still uses", async () => {
    const { destroyed } = mockCloudinary();
    const up = (await admin.agent.post(`${API}/admin/uploads`).set("X-CSRF-Token", admin.token).field("kind", "category").attach("file", JPEG, "a.jpg").expect(201)).body.data;
    const a = (await admin.post("/admin/categories", { name: "A", slug: "a", image: up }).expect(201)).body.data;
    await admin.post("/admin/categories", { name: "B", slug: "b", image: up }).expect(201);
    await admin.del(`/admin/categories/${a.id}`).expect(200);
    expect(destroyed).toEqual([]);
  });

  it("rejects files by their real content, size and kind; reports Cloudinary failures", async () => {
    const cld = mockCloudinary();
    const send = (kind, buf, name) => admin.agent.post(`${API}/admin/uploads`).set("X-CSRF-Token", admin.token).field("kind", kind).attach("file", buf, name);
    await send("product", Buffer.from("<svg onload=alert(1)></svg>".padEnd(100)), "x.jpg").expect(415);
    await send("favicon", Buffer.concat([Buffer.from("00000100", "hex"), Buffer.alloc(50)]), "f.ico").expect(201);
    await send("product", Buffer.concat([Buffer.from("00000100", "hex"), Buffer.alloc(50)]), "f.ico").expect(415);
    await send("logo", Buffer.concat([JPEG, Buffer.alloc(3 * 1024 * 1024)]), "big.jpg").expect(413);
    await send("nonsense", JPEG, "a.jpg").expect(400);
    cld.client.fail = true;
    expect((await send("product", JPEG, "a.jpg").expect(502)).body.error.code).toBe("UPLOAD_FAILED");
  });

  it("orphaned uploads are cleaned up; uploads without Cloudinary keys report 503", async () => {
    const { destroyed } = mockCloudinary();
    const up = (await admin.agent.post(`${API}/admin/uploads`).set("X-CSRF-Token", admin.token).field("kind", "product").attach("file", JPEG, "a.jpg").expect(201)).body.data;
    const { cleanupOrphanUploads } = await import("../src/services/uploadService.js");
    expect(await cleanupOrphanUploads(-1000)).toBe(1);
    expect(destroyed).toEqual([up.publicId]);

    const { setCloudinaryClient } = await import("../src/services/uploadService.js");
    setCloudinaryClient(null);
    const res = await admin.agent.post(`${API}/admin/uploads`).set("X-CSRF-Token", admin.token).field("kind", "product").attach("file", JPEG, "a.jpg").expect(503);
    expect(res.body.error.code).toBe("UPLOADS_NOT_CONFIGURED");
  });
});
