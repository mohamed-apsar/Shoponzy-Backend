import mongoose from "mongoose";

/* An image stored in Cloudinary (publicId set) or, for seeded legacy data, a remote URL (publicId null). */
export const imageSchema = new mongoose.Schema({
  url: { type: String, required: true, maxlength: 1000 },
  publicId: { type: String, maxlength: 300, default: null },
  alt: { type: String, maxlength: 200, default: "" },
  width: Number,
  height: Number,
}, { _id: false });

export const seoSchema = new mongoose.Schema({
  title: { type: String, maxlength: 70, default: "" },
  description: { type: String, maxlength: 160, default: "" },
}, { _id: false });

/* Rupees with at most 2 decimals. */
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
