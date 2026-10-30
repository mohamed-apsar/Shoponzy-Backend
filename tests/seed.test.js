import { describe, expect, it } from "vitest";
import request from "supertest";
import { API, app, useDb } from "./helpers.js";
import { seed, SAMPLE_STOCK } from "../scripts/seed.js";
import { Category } from "../src/models/Category.js";
import { Product } from "../src/models/Product.js";

useDb();
const pub = (path) => request(app).get(API + path);

describe("seed: the storefront's catalogue in MongoDB", () => {
  it("loads 6 categories, 22 sub-types, 39 products, banners, sections, pages and WELCOME10 — and is safe to re-run", async () => {
    const first = await seed();
    expect(first).toEqual({ categories: 28, products: 39, banners: 4, sections: 5, coupons: 1, pages: 7 });
    expect(await seed()).toEqual({ categories: 0, products: 0 });
    expect(await Category.countDocuments({ level: 1 })).toBe(6);
  });

  it("reproduces the original site's listings through the API", async () => {
    await seed();
    expect((await pub("/products?category=shoes").expect(200)).body.meta.total).toBe(10);
    expect((await pub("/products?category=shoes&sub=boots").expect(200)).body.meta.total).toBe(2);
    expect((await pub("/products?q=sandal").expect(200)).body.meta.total).toBe(3);
    // Default order matches the original catalogue order.
    expect((await pub("/products?limit=3").expect(200)).body.data.map((p) => p.legacyId)).toEqual(["SANDAL-1", "SANDAL-2", "BOOT-BRN"]);
    expect((await pub("/products/legacy/SH-101").expect(200)).body.data.slug).toBe("men-white-lace-up-everyday-sneakers");

    const sneaker = (await pub("/products/men-white-lace-up-everyday-sneakers").expect(200)).body.data;
    expect(sneaker).toMatchObject({ price: 1299, mrp: 2499, discountPct: 48, isNewArrival: true, badge: "Trending" });
    expect(sneaker.variants).toHaveLength(2 * 5);
    const boots = await Product.findOne({ legacyId: "BOOT-BRN" });
    expect([boots.minPrice, boots.maxPrice]).toEqual([480, 520]);
    expect(boots.variants.every((v) => v.stock === SAMPLE_STOCK)).toBe(true);

    const home = (await pub("/homepage").expect(200)).body.data;
    expect(home.banners.map((b) => b.title)).toEqual(["Step into style", "Made for the sun", "Leave a trail", "Time, well kept"]);
    expect(home.sections.map((s) => [s.title, (s.products || s.categories).length])).toEqual([
      ["New arrivals", 10], ["Bestsellers", 10], ["Explore categories", 6], ["Shoponzy shoes", 10], ["Biggest deals", 8],
    ]);
    expect((await pub("/pages/return-policy").expect(200)).body.data.content).toContain("7 days");
  });
});
