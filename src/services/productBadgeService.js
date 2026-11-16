import { Product, BADGES } from "../models/Product.js";
import { SiteSetting } from "../models/site.js";
import { AppError } from "../utils/AppError.js";

const SETTING_KEY = "productBadges";
const DEFAULT_BADGES = BADGES.filter(Boolean);

export async function getProductBadges() {
  const setting = await SiteSetting.findOne({ key: SETTING_KEY }).lean();
  return setting?.value?.badges ?? DEFAULT_BADGES;
}

export async function saveProductBadges(badges, { clearAssigned = false } = {}) {
  const previous = await getProductBadges();
  const removed = previous.filter((badge) => !badges.includes(badge));
  let clearedProducts = 0;
  if (removed.length) {
    const assigned = await Product.distinct("badge", { badge: { $in: removed } });
    if (assigned.length && !clearAssigned) {
      throw AppError.conflict(`These badges are still assigned to products: ${assigned.join(", ")}. Confirm removal to clear them from those products.`);
    }
    if (assigned.length) {
      const result = await Product.updateMany({ badge: { $in: removed } }, { $set: { badge: "" } });
      clearedProducts = result.modifiedCount ?? result.nModified ?? 0;
    }
  }
  await SiteSetting.updateOne({ key: SETTING_KEY }, { $set: { value: { badges } } }, { upsert: true });
  return { badges, clearedProducts };
}

export async function validateProductBadge(badge) {
  if (!badge) return;
  const badges = await getProductBadges();
  if (!badges.includes(badge)) throw AppError.badRequest("Select a badge from Master.");
}
