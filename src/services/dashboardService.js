import { Order } from "../models/commerce.js";
import { Product } from "../models/Product.js";
import { User } from "../models/User.js";
import { round2 } from "../models/shared.js";
import { getLowStockThreshold } from "./inventoryService.js";
import { lowStockFilter } from "./productService.js";

const TZ = "Asia/Kolkata";
// Orders that count as sales: placed and not cancelled/returned. Unpaid online orders don't count.
const COUNTED = { status: { $nin: ["pending_payment", "cancelled", "returned"] } };
const change = (cur, prev) => (prev === 0 ? (cur === 0 ? 0 : null) : round2(((cur - prev) / prev) * 100));
const dayKey = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

async function salesBetween(from, to) {
  const [r] = await Order.aggregate([
    { $match: { ...COUNTED, createdAt: { $gte: from, $lt: to } } },
    { $group: { _id: null, revenue: { $sum: { $subtract: ["$total", "$refundedAmount"] } }, orders: { $sum: 1 } } },
  ]);
  return { revenue: round2(r?.revenue || 0), orders: r?.orders || 0 };
}

export async function dashboard({ days = 30, now = new Date() } = {}) {
  const from = new Date(now.getTime() - days * 86_400_000);
  const prevFrom = new Date(from.getTime() - days * 86_400_000);
  const low = await getLowStockThreshold();

  const [cur, prev, customers, newCustomers, prevCustomers, products, pending, awaiting, attention, outOfStock, lowStockDocs, recent, trend, best] = await Promise.all([
    salesBetween(from, now),
    salesBetween(prevFrom, from),
    User.countDocuments({ role: "customer", deletedAt: null }),
    User.countDocuments({ role: "customer", createdAt: { $gte: from, $lt: now } }),
    User.countDocuments({ role: "customer", createdAt: { $gte: prevFrom, $lt: from } }),
    Product.countDocuments({ status: { $ne: "archived" } }),
    Order.countDocuments({ status: { $in: ["placed", "confirmed", "packed"] } }),
    Order.countDocuments({ status: "pending_payment" }),
    Order.countDocuments({ $or: [{ refundRequired: true }, { needsAttention: { $ne: null } }] }),
    Product.countDocuments({ status: "active", totalStock: 0 }),
    Product.find({ status: "active", ...lowStockFilter(low) })
      .select("name slug images variants lowStockThreshold").limit(10).lean(),
    Order.find({ status: { $ne: "pending_payment" } }).sort({ createdAt: -1 }).limit(5)
      .select("orderNumber contact.name total status paymentStatus paymentMethod createdAt").lean(),
    Order.aggregate([
      { $match: { ...COUNTED, createdAt: { $gte: from, $lt: now } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: TZ } }, revenue: { $sum: { $subtract: ["$total", "$refundedAmount"] } }, orders: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: { ...COUNTED, createdAt: { $gte: from, $lt: now } } },
      { $unwind: "$items" },
      { $group: { _id: "$items.product", name: { $first: "$items.name" }, image: { $first: "$items.image" }, qty: { $sum: "$items.qty" }, revenue: { $sum: "$items.lineTotal" } } },
      { $sort: { qty: -1, revenue: -1 } },
      { $limit: 5 },
    ]),
  ]);

  // One point per calendar day (IST), including days without sales.
  const byDay = new Map(trend.map((t) => [t._id, t]));
  const salesTrend = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(new Date(now.getTime() - i * 86_400_000));
    const t = byDay.get(key);
    salesTrend.push({ date: key, revenue: round2(t?.revenue || 0), orders: t?.orders || 0 });
  }

  return {
    range: { days, from, to: now },
    totals: {
      sales: { value: cur.revenue, changePct: change(cur.revenue, prev.revenue) },
      orders: { value: cur.orders, changePct: change(cur.orders, prev.orders) },
      averageOrderValue: cur.orders ? round2(cur.revenue / cur.orders) : 0,
      customers: { value: customers, newInRange: newCustomers, changePct: change(newCustomers, prevCustomers) },
      products,
    },
    pendingOrders: pending,
    awaitingPayment: awaiting,
    needsAttention: attention,
    inventory: {
      outOfStock,
      lowStockThreshold: low,
      lowStock: lowStockDocs.map((p) => ({
        id: String(p._id), name: p.name, slug: p.slug, image: p.images[0]?.url || null,
        variants: p.variants.filter((v) => v.status === "active" && v.stock > 0 && v.stock <= (p.lowStockThreshold ?? low)).map((v) => ({ id: String(v._id), sku: v.sku, color: v.color, size: v.size, stock: v.stock })),
      })),
    },
    recentOrders: recent.map((o) => ({ id: String(o._id), orderNumber: o.orderNumber, customer: o.contact.name, total: o.total, status: o.status, paymentStatus: o.paymentStatus, paymentMethod: o.paymentMethod, createdAt: o.createdAt })),
    salesTrend,
    bestSellers: best.map((b) => ({ productId: String(b._id), name: b.name, image: b.image, qty: b.qty, revenue: round2(b.revenue) })),
  };
}
