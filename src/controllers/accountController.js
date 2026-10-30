import { User } from "../models/User.js";
import * as account from "../services/accountService.js";
import { clearAuthCookies } from "../services/tokenService.js";
import { productsByIds } from "../services/catalogService.js";
import { Product } from "../models/Product.js";
import { AppError } from "../utils/AppError.js";
import { ok } from "../utils/respond.js";

const uid = (req) => req.auth.user._id;

export const updateProfile = async (req, res) => ok(res, { user: await account.updateProfile(uid(req), req.valid.body) });

export async function changePassword(req, res) {
  await account.changePassword(uid(req), req.valid.body, req.auth.sessionId);
  ok(res, { changed: true });
}

export async function deleteAccount(req, res) {
  await account.deleteAccount(uid(req), req.valid.body.password);
  clearAuthCookies(res, "customer");
  ok(res, { deleted: true });
}

export const addresses = async (req, res) => ok(res, (await User.findById(uid(req))).addresses);
export const addAddress = async (req, res) => ok(res, await account.addAddress(uid(req), req.valid.body));
export const updateAddress = async (req, res) => ok(res, await account.updateAddress(uid(req), req.params.addressId, req.valid.body));
export const removeAddress = async (req, res) => ok(res, await account.removeAddress(uid(req), req.params.addressId));

export async function forgotPassword(req, res) {
  await account.forgotPassword(req.valid.body.email);
  ok(res, { message: "If an account exists for that email, we've sent a reset link." });
}

export async function resetPassword(req, res) {
  await account.resetPassword(req.valid.body.token, req.valid.body.password);
  ok(res, { reset: true });
}

/* ---------- Wishlist ---------- */
const wishlistView = async (userId) => productsByIds((await User.findById(userId).select("wishlist").lean()).wishlist);
export const wishlist = async (req, res) => ok(res, await wishlistView(uid(req)));

export async function addToWishlist(req, res) {
  if (!(await Product.exists({ _id: req.valid.body.productId, status: "active" }))) throw AppError.notFound("Product not found.");
  await User.updateOne({ _id: uid(req) }, { $addToSet: { wishlist: req.valid.body.productId } });
  ok(res, await wishlistView(uid(req)));
}

export async function removeFromWishlist(req, res) {
  await User.updateOne({ _id: uid(req) }, { $pull: { wishlist: req.params.productId } });
  ok(res, await wishlistView(uid(req)));
}

/* After sign-in, the storefront sends the guest wishlist kept in the browser. */
export async function mergeWishlist(req, res) {
  const valid = await Product.find({ _id: { $in: req.valid.body.productIds }, status: "active" }).select("_id").lean();
  await User.updateOne({ _id: uid(req) }, { $addToSet: { wishlist: { $each: valid.map((p) => p._id) } } });
  ok(res, await wishlistView(uid(req)));
}
