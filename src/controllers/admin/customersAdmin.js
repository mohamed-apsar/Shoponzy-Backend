import { User } from "../../models/User.js";
import { Order } from "../../models/commerce.js";
import { audit } from "../../models/AuditLog.js";
import { revokeAllSessions } from "../../services/authService.js";
import { AppError } from "../../utils/AppError.js";
import { ok, paginate } from "../../utils/respond.js";

/* GET /admin/users/:id — profile, addresses, wishlist and order history summary. */
export async function getCustomer(req, res) {
  const user = await User.findById(req.params.id).populate("wishlist", "name slug images minPrice status");
  if (!user) throw AppError.notFound("Customer not found.");
  const { skip, limit, meta } = paginate(req.query);
  const counted = { user: user._id, status: { $nin: ["pending_payment", "cancelled", "returned"] } };
  const [orders, total, [stats]] = await Promise.all([
    Order.find({ user: user._id }).sort({ createdAt: -1 }).skip(skip).limit(limit).select("orderNumber total status paymentStatus paymentMethod createdAt items.qty"),
    Order.countDocuments({ user: user._id }),
    Order.aggregate([{ $match: counted }, { $group: { _id: null, spent: { $sum: { $subtract: ["$total", "$refundedAmount"] } }, orders: { $sum: 1 }, last: { $max: "$createdAt" } } }]),
  ]);
  ok(res, { user, orders, ordersMeta: meta(total), stats: { totalSpent: stats?.spent || 0, orders: stats?.orders || 0, lastOrderAt: stats?.last || null } });
}

/* Disabling signs the customer out everywhere immediately. */
export async function setStatus(req, res) {
  const user = await User.findById(req.params.id);
  if (!user) throw AppError.notFound("Customer not found.");
  if (String(user._id) === String(req.auth.user._id)) throw AppError.badRequest("You can't change your own account status.");
  if (user.role === "admin") throw AppError.forbidden("Admin accounts are managed with the create-admin tool.");
  user.status = req.valid.body.status;
  await user.save();
  if (user.status === "disabled") await revokeAllSessions(user._id, "disabled_by_admin");
  await audit(`user.${user.status === "disabled" ? "disabled" : "enabled"}`, { actor: req.auth.user._id, entity: "User", entityId: user._id, ip: req.ip });
  ok(res, { user });
}

/* Most-wishlisted products across all customers. */
export async function wishlistStats(req, res) {
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const rows = await User.aggregate([
    { $match: { role: "customer" } }, { $unwind: "$wishlist" },
    { $group: { _id: "$wishlist", count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: limit },
    { $lookup: { from: "products", localField: "_id", foreignField: "_id", as: "product" } }, { $unwind: "$product" },
    { $project: { _id: 0, productId: "$_id", count: 1, name: "$product.name", slug: "$product.slug", image: { $arrayElemAt: ["$product.images.url", 0] }, price: "$product.minPrice", totalStock: "$product.totalStock", status: "$product.status" } },
  ]);
  ok(res, rows);
}
