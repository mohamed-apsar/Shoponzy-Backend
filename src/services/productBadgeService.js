import { Product, BADGES } from "../models/Product.js";
import { SiteSetting } from "../models/site.js";
import { AppError } from "../utils/AppError.js";

const SETTING_KEY = "productBadges";
const DEFAULT_BADGES = BADGES.filter(Boolean);

export async function getProductBadges() {
  const setting = await SiteSetting.findOne({ key: SETTING_KEY }).lean();
  return setting?.value?.badges ?? DEFAULT_BADGES;
}

export async function saveProductBadges(badges) {
  const previous = await getProductBadges();
  const removed = previous.filter((badge) => !badges.includes(badge));
  if (removed.length) {
    const assigned = await Product.distinct("badge", { badge: { $in: removed } });
    if (assigned.length) throw AppError.conflict(`Remove these badges from products before deleting them: ${assigned.join(", ")}.`);
  }
  await SiteSetting.updateOne({ key: SETTING_KEY }, { $set: { value: { badges } } }, { upsert: true });
  return badges;
}

export async function validateProductBadge(badge) {
  if (!badge) return;
  const badges = await getProductBadges();
  if (!badges.includes(badge)) throw AppError.badRequest("Select a badge from Master.");
}
