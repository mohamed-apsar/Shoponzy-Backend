import { Order, Payment, ReturnRequest } from "../../models/commerce.js";
import { AppError } from "../../utils/AppError.js";
import { ok } from "../../utils/respond.js";

const cancellations = () => ({
  status: "cancelled", cancellationReviewedAt: null,
  $or: [{ customerCancelledAt: { $ne: null } }, { cancelReason: "Cancelled by customer" }, { refundRequired: true }],
});

const HISTORY_LIMIT = 50;
const orderStatuses = ["placed", "confirmed", "packed", "shipped", "out_for_delivery", "delivered", "cancelled", "returned"];

function historyActivity(Model, source, since, extra = {}) {
  const entry = source === "order"
    ? { status: { $in: orderStatuses }, note: { $not: /^Refund / } }
    : { status: { $type: "string" }, refundStatus: null };
  const stageFilter = Object.fromEntries(Object.entries(entry).map(([key, filter]) => [`history.${key}`, filter]));
  return Model.aggregate([
    { $match: { "history.at": { $gte: since }, ...extra } },
    { $unwind: { path: "$history", includeArrayIndex: "eventIndex" } },
    { $match: { "history.at": { $gte: since }, ...stageFilter } },
    { $sort: { "history.at": -1, _id: -1, eventIndex: -1 } },
    { $limit: HISTORY_LIMIT },
    { $project: { source: { $literal: source }, eventIndex: 1, orderNumber: 1, returnNumber: 1, customer: "$contact.name", status: "$history.status", at: "$history.at" } },
  ]);
}

async function recentActivity() {
  const since = new Date(Date.now() - 30 * 86400_000);
  const [orders, returns, refunds] = await Promise.all([
    historyActivity(Order, "order", since, { placedAt: { $type: "date" } }),
    historyActivity(ReturnRequest, "return", since),
    Payment.aggregate([
      { $match: { $or: [{ "refunds.at": { $gte: since } }, { "refunds.processedAt": { $gte: since } }, { "refunds.failedAt": { $gte: since } }] } },
      { $unwind: { path: "$refunds", includeArrayIndex: "eventIndex" } },
      { $set: { at: { $ifNull: ["$refunds.failedAt", "$refunds.processedAt", "$refunds.at"] } } },
      { $match: { at: { $gte: since } } },
      { $sort: { at: -1, _id: -1, eventIndex: -1 } },
      { $limit: HISTORY_LIMIT },
      { $lookup: { from: Order.collection.name, localField: "order", foreignField: "_id", as: "order" } },
      { $unwind: "$order" },
      { $project: { source: { $literal: "refund" }, eventIndex: 1, orderNumber: "$order.orderNumber", customer: "$order.contact.name", status: "$refunds.status", amount: "$refunds.amount", at: 1 } },
    ]),
  ]);
  return [...orders, ...returns, ...refunds]
    .map(({ _id, eventIndex, ...event }) => ({ ...event, id: `${event.source}-${_id}-${eventIndex}` }))
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .slice(0, HISTORY_LIMIT);
}

export async function list(_req, res) {
  const [orders, returns, cancelledCount, returnCount, activity] = await Promise.all([
    Order.find(cancellations()).sort({ updatedAt: -1 }).limit(5).select("orderNumber contact.name cancelReason refundRequired updatedAt").lean(),
    ReturnRequest.find({ status: "requested" }).sort({ createdAt: -1 }).limit(5).select("returnNumber orderNumber contact.name reasonLabel createdAt").lean(),
    Order.countDocuments(cancellations()),
    ReturnRequest.countDocuments({ status: "requested" }),
    recentActivity(),
  ]);
  ok(res, {
    activity,
    cancellations: orders.map((order) => ({ id: String(order._id), orderNumber: order.orderNumber, customer: order.contact?.name, message: order.refundRequired ? "Order cancelled — refund review required" : "Customer cancelled this order", at: order.updatedAt })),
    returns: returns.map((rr) => ({ id: String(rr._id), returnNumber: rr.returnNumber, orderNumber: rr.orderNumber, customer: rr.contact?.name, message: rr.reasonLabel || "Return requested", at: rr.createdAt })),
    cancelledCount, returnCount, total: cancelledCount + returnCount,
  });
}

export async function reviewCancellation(req, res) {
  const order = await Order.findOneAndUpdate({ _id: req.params.id, status: "cancelled" }, { $set: { cancellationReviewedAt: new Date() } }, { new: true });
  if (!order) throw AppError.notFound("Cancelled order not found.");
  ok(res, { reviewed: true });
}
