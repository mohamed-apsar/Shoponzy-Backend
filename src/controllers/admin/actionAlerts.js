import { Order, ReturnRequest } from "../../models/commerce.js";
import { AppError } from "../../utils/AppError.js";
import { ok } from "../../utils/respond.js";

const cancellations = () => ({
  status: "cancelled", cancellationReviewedAt: null,
  $or: [{ customerCancelledAt: { $ne: null } }, { cancelReason: "Cancelled by customer" }, { refundRequired: true }],
});

export async function list(_req, res) {
  const [orders, returns, cancelledCount, returnCount] = await Promise.all([
    Order.find(cancellations()).sort({ updatedAt: -1 }).limit(5).select("orderNumber contact.name cancelReason refundRequired updatedAt").lean(),
    ReturnRequest.find({ status: "requested" }).sort({ createdAt: -1 }).limit(5).select("returnNumber orderNumber contact.name reasonLabel createdAt").lean(),
    Order.countDocuments(cancellations()),
    ReturnRequest.countDocuments({ status: "requested" }),
  ]);
  ok(res, {
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
