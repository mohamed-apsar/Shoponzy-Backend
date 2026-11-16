import { audit } from "../../models/AuditLog.js";
import * as badges from "../../services/productBadgeService.js";
import { ok } from "../../utils/respond.js";

export async function list(_req, res) {
  ok(res, { badges: await badges.getProductBadges() });
}

export async function save(req, res) {
  const result = await badges.saveProductBadges(req.valid.body.badges, { clearAssigned: req.valid.body.clearAssigned });
  await audit("product_badges.updated", { actor: req.auth.user._id, entity: "SiteSetting", entityId: "productBadges", ip: req.ip });
  ok(res, result);
}
