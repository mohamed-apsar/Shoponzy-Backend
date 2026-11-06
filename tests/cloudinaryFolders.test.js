import { describe, expect, it, beforeEach } from "vitest";
import { API, useDb } from "./helpers.js";
import { adminBrowser, mockCloudinary } from "./fixtures.js";
import { UPLOAD_KINDS, isReferenced, releaseImages, uploadFolder } from "../src/services/uploadService.js";
import { ReturnRequest, Upload } from "../src/models/commerce.js";
import mongoose from "mongoose";

useDb();
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("Cloudinary folder structure", () => {
  let cloud, admin;
  beforeEach(async () => { cloud = mockCloudinary(); admin = await adminBrowser(); });

  it("maps every upload kind under the shoponzy root", () => {
    expect(Object.fromEntries(Object.keys(UPLOAD_KINDS).map((k) => [k, uploadFolder(k)]))).toEqual({
      product: "shoponzy/products/product-images",
      productGallery: "shoponzy/products/product-gallery",
      productVariant: "shoponzy/products/product-variants",
      category: "shoponzy/categories/category-images",
      categoryBanner: "shoponzy/categories/category-banners",
      banner: "shoponzy/banners/desktop",
      bannerMobile: "shoponzy/banners/mobile",
      logo: "shoponzy/branding/logos",
      favicon: "shoponzy/branding/favicons",
      popup: "shoponzy/popups",
      seo: "shoponzy/seo",
      maintenance: "shoponzy/site/maintenance",
      site: "shoponzy/site/general",
      returnEvidence: "shoponzy/returns/return-evidence",
    });
  });

  it("uploads into the kind's folder and stores the asset metadata", async () => {
    for (const kind of ["productGallery", "bannerMobile", "categoryBanner", "site"]) {
      const res = await admin.agent.post(`${API}/admin/uploads`).set("X-CSRF-Token", admin.token).field("kind", kind).attach("file", png, "a.png").expect(201);
      expect(res.body.data.publicId.startsWith(`${uploadFolder(kind)}/`)).toBe(true);
      expect(await Upload.findOne({ publicId: res.body.data.publicId }).lean()).toMatchObject({ kind, width: 800, height: 800, format: "jpg", url: res.body.data.url });
    }
    expect(cloud.uploaded.size).toBe(4);
    await admin.agent.post(`${API}/admin/uploads`).set("X-CSRF-Token", admin.token).field("kind", "nope").attach("file", png, "a.png").expect(400);
  });

  it("never deletes a return-evidence photo still attached to a return request", async () => {
    const res = await admin.agent.post(`${API}/admin/uploads`).set("X-CSRF-Token", admin.token).field("kind", "returnEvidence").attach("file", png, "a.png").expect(201);
    const { publicId, url } = res.body.data;
    await ReturnRequest.create({
      returnNumber: "RT100001", order: new mongoose.Types.ObjectId(), orderNumber: "SZ100001", reason: "damaged",
      items: [{ name: "x", qty: 1, price: 1 }], evidence: [{ url, publicId }],
    });
    expect(await isReferenced(publicId)).toBe(true);
    await releaseImages([publicId]);
    expect(cloud.destroyed).toEqual([]);
    expect(await Upload.exists({ publicId })).toBeTruthy();
  });
});
