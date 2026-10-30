import mongoose from "mongoose";
import { toJSONPlugin } from "./plugins.js";

/* Append-only record of security-relevant and administrative actions. */
const auditLogSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  action: { type: String, required: true, index: true }, // e.g. "auth.admin_login", "admin.created"
  entity: String,
  entityId: String,
  meta: mongoose.Schema.Types.Mixed,
  ip: String,
}, { timestamps: { createdAt: true, updatedAt: false } });

auditLogSchema.index({ createdAt: -1 });
toJSONPlugin(auditLogSchema);

export const AuditLog = mongoose.model("AuditLog", auditLogSchema);

export function audit(action, { actor, entity, entityId, meta, ip } = {}) {
  return AuditLog.create({ action, actor, entity, entityId: entityId && String(entityId), meta, ip });
}
