import mongoose from "mongoose";

/* One row per signed-in browser. Only a SHA-256 hash of the refresh token is stored.
   Refreshing rotates the token (old row revoked, `replacedBy` set); presenting a revoked
   token again is treated as theft and revokes every session of that user. */
const sessionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  audience: { type: String, enum: ["customer", "admin"], required: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  revokedAt: Date,
  revokedReason: String,
  replacedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Session" },
  userAgent: { type: String, maxlength: 300 },
  ip: String,
}, { timestamps: true });

// MongoDB removes expired sessions automatically.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

sessionSchema.methods.isActive = function isActive() {
  return !this.revokedAt && this.expiresAt > new Date();
};

export const Session = mongoose.model("Session", sessionSchema);
