import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { env } from "../config/env.js";
import { User } from "../models/User.js";
import { Session } from "../models/Session.js";
import { Cart, PasswordReset } from "../models/commerce.js";
import { audit } from "../models/AuditLog.js";
import { AppError } from "../utils/AppError.js";
import { hashPassword, revokeAllSessions } from "./authService.js";
import { hashToken } from "./tokenService.js";
import { emailEnabled, passwordResetEmail, sendMail } from "./emailService.js";

const RESET_TTL_MS = 60 * 60_000;

async function checkPassword(userId, password) {
  const user = await User.findById(userId).select("+passwordHash");
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw new AppError(400, "WRONG_PASSWORD", "Your current password is incorrect.");
  return user;
}

export async function updateProfile(userId, { name, phone }) {
  const user = await User.findById(userId);
  if (name !== undefined) user.name = name;
  if (phone !== undefined) user.phone = phone || undefined;
  await user.save();
  return user;
}

/* Changing the password signs out every other device. */
export async function changePassword(userId, { currentPassword, newPassword }, keepSessionId) {
  const user = await checkPassword(userId, currentPassword);
  user.passwordHash = await hashPassword(newPassword);
  await user.save();
  await Session.updateMany({ user: userId, revokedAt: null, _id: { $ne: keepSessionId } }, { revokedAt: new Date(), revokedReason: "password_changed" });
}

export async function changeAdminEmail(userId, { currentPassword, newEmail }, keepSessionId) {
  const user = await checkPassword(userId, currentPassword);
  if (user.role !== "admin") throw AppError.forbidden();
  const normalizedEmail = newEmail.trim().toLowerCase();
  if (normalizedEmail === user.email) return user;
  if (await User.exists({ email: normalizedEmail, _id: { $ne: userId } })) {
    throw AppError.conflict("An account with this email already exists.");
  }
  user.email = normalizedEmail;
  try {
    await user.save();
  } catch (error) {
    if (error?.code === 11000) throw AppError.conflict("An account with this email already exists.");
    throw error;
  }
  await Session.updateMany({ user: userId, revokedAt: null, _id: { $ne: keepSessionId } }, { revokedAt: new Date(), revokedReason: "email_changed" });
  return user;
}

export async function changeAdminCredentials(userId, { currentPassword, newEmail, newPassword }, keepSessionId) {
  const user = await checkPassword(userId, currentPassword);
  if (user.role !== "admin") throw AppError.forbidden();
  const normalizedEmail = newEmail.trim().toLowerCase();
  if (await User.exists({ email: normalizedEmail, _id: { $ne: userId } })) {
    throw AppError.conflict("An account with this email already exists.");
  }
  user.email = normalizedEmail;
  user.passwordHash = await hashPassword(newPassword);
  try {
    await user.save();
  } catch (error) {
    if (error?.code === 11000) throw AppError.conflict("An account with this email already exists.");
    throw error;
  }
  await Session.updateMany({ user: userId, revokedAt: null, _id: { $ne: keepSessionId } }, { revokedAt: new Date(), revokedReason: "credentials_changed" });
  return user;
}

/* ---------- Addresses ---------- */
export async function addAddress(userId, data) {
  const user = await User.findById(userId);
  if (user.addresses.length >= 10) throw AppError.badRequest("You can save up to 10 addresses.");
  const makeDefault = data.isDefault || user.addresses.length === 0;
  if (makeDefault) user.addresses.forEach((a) => { a.isDefault = false; });
  user.addresses.push({ ...data, isDefault: makeDefault });
  await user.save();
  return user.addresses;
}

export async function updateAddress(userId, addressId, data) {
  const user = await User.findById(userId);
  const addr = user.addresses.id(addressId);
  if (!addr) throw AppError.notFound("Address not found.");
  if (data.isDefault) user.addresses.forEach((a) => { a.isDefault = false; });
  Object.assign(addr, data);
  if (!user.addresses.some((a) => a.isDefault)) user.addresses[0].isDefault = true;
  await user.save();
  return user.addresses;
}

export async function removeAddress(userId, addressId) {
  const user = await User.findById(userId);
  const addr = user.addresses.id(addressId);
  if (!addr) throw AppError.notFound("Address not found.");
  const wasDefault = addr.isDefault;
  addr.deleteOne();
  if (wasDefault && user.addresses.length) user.addresses[0].isDefault = true;
  await user.save();
  return user.addresses;
}

/* ---------- Account deletion ----------
   Personal data is removed from the account; orders are kept (with the contact details
   given at checkout) because they are financial records. */
export async function deleteAccount(userId, password) {
  const user = await checkPassword(userId, password);
  if (user.role === "admin") throw AppError.forbidden("Admin accounts can't be deleted from the storefront.");
  user.name = "Deleted user";
  user.email = `deleted+${user._id}@deleted.invalid`;
  user.phone = undefined;
  user.addresses = [];
  user.wishlist = [];
  user.status = "disabled";
  user.deletedAt = new Date();
  user.passwordHash = await hashPassword(crypto.randomBytes(32).toString("hex"));
  await user.save();
  await Cart.deleteOne({ user: user._id });
  await revokeAllSessions(user._id, "account_deleted");
  await audit("account.deleted", { actor: user._id, entity: "User", entityId: user._id });
}

/* ---------- Password reset ---------- */
export async function forgotPassword(email) {
  if (!emailEnabled()) throw new AppError(503, "EMAIL_NOT_CONFIGURED", "Password reset by email isn't available yet. Please contact support.");
  const user = await User.findOne({ email, status: "active" });
  // Same response whether or not the account exists.
  if (!user) return;
  const token = crypto.randomBytes(32).toString("base64url");
  await PasswordReset.deleteMany({ user: user._id, usedAt: null });
  await PasswordReset.create({ user: user._id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) });
  const link = `${env.CLIENT_URL}/reset-password?token=${token}`;
  await sendMail({ to: user.email, ...passwordResetEmail({ name: user.name, link }), type: "password_reset" });
}

export async function resetPassword(token, newPassword) {
  const reset = await PasswordReset.findOneAndUpdate(
    { tokenHash: hashToken(token), usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
  );
  if (!reset) throw new AppError(400, "INVALID_RESET_LINK", "This reset link is invalid or has expired. Please request a new one.");
  const user = await User.findOne({ _id: reset.user, status: "active" });
  if (!user) throw new AppError(400, "INVALID_RESET_LINK", "This reset link is invalid or has expired. Please request a new one.");
  user.passwordHash = await hashPassword(newPassword);
  await user.save();
  await revokeAllSessions(user._id, "password_reset");
  await audit("account.password_reset", { actor: user._id, entity: "User", entityId: user._id });
}
