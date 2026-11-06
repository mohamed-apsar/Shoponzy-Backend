import { User } from "../models/User.js";
import { Order } from "../models/commerce.js";
import { audit } from "../models/AuditLog.js";
import { MAX_EXPORT_ROWS, csvDate, sendCsv } from "../utils/csv.js";
import { escapeRegex } from "../validators/common.js";
import { ok, paginate } from "../utils/respond.js";

const SORTS = { newest: { createdAt: -1 }, oldest: { createdAt: 1 }, name: { name: 1 } };

/* GET /admin/users — paginated, searchable list (Customer List in the admin panel). */
export async function listUsers(req, res) {
  const { q, role, status, sort, ...pageQuery } = req.valid.query;
  const filter = { role };
  if (status) filter.status = status;
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ name: rx }, { email: rx }, { phone: rx }];
  }
  const { skip, limit, meta } = paginate(pageQuery);
  const [items, total] = await Promise.all([
    User.find(filter).sort(SORTS[sort]).skip(skip).limit(limit).select("-addresses"),
    User.countDocuments(filter),
  ]);
  ok(res, items, meta(total));
}

/* GET /admin/users/export.csv — the Customer List with order statistics, same filters as the list. */
export async function exportUsers(req, res) {
  const { q, role, status, sort } = req.valid.query;
  const filter = { role };
  if (status) filter.status = status;
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ name: rx }, { email: rx }, { phone: rx }];
  }
  const users = await User.find(filter).sort(SORTS[sort]).limit(MAX_EXPORT_ROWS).select("name email phone status createdAt lastLoginAt addresses wishlist deletedAt").lean();
  // Spend counts placed orders net of refunds (as on the customer detail page); unpaid, cancelled and returned orders are excluded.
  const stats = await Order.aggregate([
    { $match: { user: { $in: users.map((u) => u._id) } } },
    { $group: {
      _id: "$user",
      orders: { $sum: 1 },
      counted: { $sum: { $cond: [{ $in: ["$status", ["pending_payment", "cancelled", "returned"]] }, 0, 1] } },
      spent: { $sum: { $cond: [{ $in: ["$status", ["pending_payment", "cancelled", "returned"]] }, 0, { $subtract: ["$total", "$refundedAmount"] }] } },
      last: { $max: "$createdAt" },
    } },
  ]);
  const byUser = new Map(stats.map((s) => [String(s._id), s]));
  const rows = [["name", "email", "phone", "status", "joined", "last_login", "orders_total", "orders_counted", "total_spent", "last_order", "default_city", "default_state", "saved_addresses", "wishlist_items"]];
  for (const u of users) {
    const s = byUser.get(String(u._id)) || {};
    const addr = u.addresses?.find((a) => a.isDefault) || u.addresses?.[0];
    rows.push([u.name, u.email, u.phone, u.deletedAt ? "deleted" : u.status, csvDate(u.createdAt), csvDate(u.lastLoginAt), s.orders || 0, s.counted || 0,
      Math.round((s.spent || 0) * 100) / 100, csvDate(s.last), addr?.city, addr?.state, u.addresses?.length || 0, u.wishlist?.length || 0]);
  }
  await audit("customers.exported", { actor: req.auth.user._id, entity: "User", ip: req.ip, meta: { rows: users.length, filters: { q, status, sort } } });
  sendCsv(res, `shoponzy-customers-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}
