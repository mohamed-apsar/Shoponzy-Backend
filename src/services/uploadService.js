import { v2 as cloudinarySdk } from "cloudinary";
import { cloudinaryConfigured, env } from "../config/env.js";
import { ReturnRequest, Upload } from "../models/commerce.js";
import { Category } from "../models/Category.js";
import { Product } from "../models/Product.js";
import { Banner, Popup, SiteSetting } from "../models/site.js";
import { AppError } from "../utils/AppError.js";
import { logger } from "../utils/logger.js";

/* All Shoponzy media lives under one Cloudinary root; each upload kind has its own sub-folder.
   Cloudinary creates a folder on the first upload into it, so these paths are the structure:

   shoponzy/products/{product-images,product-gallery,product-variants}
   shoponzy/categories/{category-images,category-banners}
   shoponzy/banners/{desktop,mobile}      shoponzy/branding/{logos,favicons}
   shoponzy/popups   shoponzy/seo   shoponzy/site/{maintenance,general}   shoponzy/returns/return-evidence

   Assets uploaded before this layout keep their original public ids (the id embeds the folder), so
   existing references stay valid. What may be uploaded and how big it may be is set per kind.
   SVG is never accepted (it can carry scripts). */
export const CLOUDINARY_ROOT = "shoponzy";
const MB = 1024 * 1024;
export const UPLOAD_KINDS = {
  product: { folder: "products/product-images", maxBytes: 5 * MB },
  productGallery: { folder: "products/product-gallery", maxBytes: 5 * MB },
  productVariant: { folder: "products/product-variants", maxBytes: 5 * MB },
  category: { folder: "categories/category-images", maxBytes: 5 * MB },
  categoryBanner: { folder: "categories/category-banners", maxBytes: 8 * MB },
  banner: { folder: "banners/desktop", maxBytes: 8 * MB },
  bannerMobile: { folder: "banners/mobile", maxBytes: 8 * MB },
  logo: { folder: "branding/logos", maxBytes: 2 * MB },
  favicon: { folder: "branding/favicons", maxBytes: MB, ico: true },
  popup: { folder: "popups", maxBytes: 5 * MB },
  seo: { folder: "seo", maxBytes: 5 * MB },
  maintenance: { folder: "site/maintenance", maxBytes: 5 * MB },
  site: { folder: "site/general", maxBytes: 5 * MB },
  // Photos customers attach to a return request (uploaded from the storefront, not the admin panel).
  returnEvidence: { folder: "returns/return-evidence", maxBytes: 5 * MB },
};
export const uploadFolder = (kind) => `${CLOUDINARY_ROOT}/${UPLOAD_KINDS[kind].folder}`;
export const MAX_UPLOAD_BYTES = 8 * MB;

/* Identify the real file type from its first bytes; the browser-supplied MIME type is not trusted. */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  const hex = buf.subarray(0, 12).toString("hex");
  if (hex.startsWith("ffd8ff")) return "jpeg";
  if (hex.startsWith("89504e470d0a1a0a")) return "png";
  if (hex.startsWith("474946383761") || hex.startsWith("474946383961")) return "gif";
  if (hex.startsWith("52494646") && buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (buf.subarray(4, 12).toString("ascii").match(/^ftypavi[fs]$/)) return "avif";
  if (hex.startsWith("00000100")) return "ico";
  return null;
}

/* The Cloudinary client is swappable so tests never hit the network. */
let client = null;
function getClient() {
  if (client) return client;
  if (!cloudinaryConfigured) throw new AppError(503, "UPLOADS_NOT_CONFIGURED", "Image uploads are not configured on the server (Cloudinary keys missing).");
  cloudinarySdk.config({ cloud_name: env.CLOUDINARY_CLOUD_NAME, api_key: env.CLOUDINARY_API_KEY, api_secret: env.CLOUDINARY_API_SECRET, secure: true });
  client = {
    upload: (buffer, options) => new Promise((resolve, reject) => {
      cloudinarySdk.uploader.upload_stream(options, (err, result) => (err ? reject(err) : resolve(result))).end(buffer);
    }),
    destroy: (publicId) => cloudinarySdk.uploader.destroy(publicId, { resource_type: "image", invalidate: true }),
  };
  return client;
}
export const setCloudinaryClient = (c) => { client = c; };

export async function uploadImage({ buffer, size }, kind, user) {
  const rule = UPLOAD_KINDS[kind];
  if (!rule) throw AppError.badRequest(`Unknown upload kind. Use one of: ${Object.keys(UPLOAD_KINDS).join(", ")}.`);
  if (size > rule.maxBytes) throw new AppError(413, "FILE_TOO_LARGE", `Images for ${kind} must be under ${Math.round(rule.maxBytes / 1024 / 1024)} MB.`);
  const type = sniffImage(buffer);
  if (!type || (type === "ico" && !rule.ico)) throw new AppError(415, "UNSUPPORTED_FILE", "Upload a JPG, PNG, WebP, GIF or AVIF image.");

  let result;
  try {
    result = await getClient().upload(buffer, {
      folder: uploadFolder(kind), resource_type: "image", unique_filename: true, overwrite: false,
      allowed_formats: ["jpg", "jpeg", "png", "webp", "gif", "avif", "ico"],
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error({ err: { message: err?.message, http_code: err?.http_code } }, "Cloudinary upload failed");
    throw new AppError(502, "UPLOAD_FAILED", "The image could not be uploaded. Please try again.");
  }
  return Upload.create({
    publicId: result.public_id, url: result.secure_url, kind, bytes: result.bytes, width: result.width, height: result.height,
    format: result.format, uploadedBy: user?._id,
  });
}

/* Ensures an image reference came from our upload endpoint and returns the canonical stored form. */
export async function resolveImage(ref) {
  if (!ref) return null;
  if (!ref.publicId) throw AppError.badRequest("Images must be uploaded through the admin panel first.");
  const up = await Upload.findOne({ publicId: ref.publicId }).lean();
  if (!up) throw AppError.badRequest("Unknown image. Please upload it again.");
  return { url: up.url, publicId: up.publicId, alt: (ref.alt || "").slice(0, 200), width: up.width, height: up.height };
}
export const resolveImages = (refs = []) => Promise.all(refs.map(resolveImage));

/* Like resolveImage, but an image the document already has is kept as stored — including seeded
   images that were never uploaded through the admin panel (publicId null). */
export async function resolveImageKeeping(ref, existing = []) {
  if (ref && !ref.publicId) {
    const kept = [].concat(existing).filter(Boolean).find((img) => img.url === ref.url && !img.publicId);
    if (kept) return { url: kept.url, publicId: null, alt: (ref.alt ?? kept.alt ?? "").slice(0, 200), width: kept.width, height: kept.height };
  }
  return resolveImage(ref);
}
export const resolveImagesKeeping = (refs = [], existing = []) => Promise.all(refs.map((ref) => resolveImageKeeping(ref, existing)));

/* Is any document still pointing at this Cloudinary asset? */
export async function isReferenced(publicId) {
  const checks = await Promise.all([
    Category.exists({ $or: [{ "image.publicId": publicId }, { "productImage.publicId": publicId }, { "exploreImage.publicId": publicId }, { "bannerImage.publicId": publicId }] }),
    Product.exists({ $or: [
      { "images.publicId": publicId },
      { "colors.featuredImage.publicId": publicId },
      { "colors.images.publicId": publicId },
      { "contentBlocks.image.publicId": publicId },
      { "contentBlocks.images.publicId": publicId },
      { "seo.image.publicId": publicId },
    ] }),
    Banner.exists({ $or: [{ "image.publicId": publicId }, { "mobileImage.publicId": publicId }] }),
    Popup.exists({ "image.publicId": publicId }),
    ReturnRequest.exists({ "evidence.publicId": publicId }),
    // Settings are a handful of free-form documents (one per Manage Site section); scan them.
    SiteSetting.find().lean().then((docs) => docs.some((d) => JSON.stringify(d.value).includes(`"${publicId}"`))),
  ]);
  return checks.some(Boolean);
}

/* Deletes assets that are no longer referenced. Failures are logged, never thrown: the
   entity change has already succeeded, and the orphan sweep will retry later. */
export async function releaseImages(publicIds) {
  for (const publicId of new Set(publicIds.filter(Boolean))) {
    try {
      if (await isReferenced(publicId)) continue;
      if (await Upload.exists({ publicId })) {
        await getClient().destroy(publicId);
        await Upload.deleteOne({ publicId });
      }
    } catch (err) {
      logger.warn({ publicId, err: err?.message }, "Could not delete unreferenced image; will retry in cleanup");
    }
  }
}

/* Uploads never attached to anything within `olderThanMs` are removed (abandoned forms). */
export async function cleanupOrphanUploads(olderThanMs = 24 * 3_600_000) {
  const stale = await Upload.find({ createdAt: { $lt: new Date(Date.now() - olderThanMs) } }).select("publicId").lean();
  const before = await Upload.countDocuments();
  await releaseImages(stale.map((u) => u.publicId));
  return before - (await Upload.countDocuments());
}

export const imageIds = (...imgs) => imgs.flat().filter(Boolean).map((i) => i.publicId).filter(Boolean);
