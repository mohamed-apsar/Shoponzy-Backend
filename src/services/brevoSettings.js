import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { env } from "../config/env.js";

const Settings = mongoose.model("BrevoSettings", new mongoose.Schema({
  _id: String,
  credentials: { type: String, required: true },
}));
const id = "transactional-smtp";
const key = createHash("sha256").update("shoponzy:brevo:" + env.JWT_SECRET).digest();

export async function saveBrevoSettings(settings) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(settings), "utf8"), cipher.final()]);
  const credentials = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  await Settings.updateOne({ _id: id }, { $set: { credentials } }, { upsert: true });
}

export async function readBrevoSettings() {
  const saved = await Settings.findById(id).lean();
  if (!saved) return null;
  try {
    const value = Buffer.from(saved.credentials, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8"));
  } catch {
    return null;
  }
}
