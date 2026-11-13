import { Order, ReturnRequest } from "../models/commerce.js";
import { audit } from "../models/AuditLog.js";
import * as returns from "../services/returnService.js";
import { uploadImage } from "../services/uploadService.js";
import { AppError } from "../utils/AppError.js";
import { created, ok } from "../utils/respond.js";

/* Customers (signed in, or the guest browser that placed the order) manage returns for their own orders. */
const scopeOf = (owner) => (owner.userId ? { user: owner.userId } : owner.guestId ? { guestId: owner.guestId } : null);

async function ownOrder(req) {
  const scope = scopeOf(req.owner);
  const order = scope && (await Order.findOne({ orderNumber: String(req.params.orderNumber).toUpperCase(), ...scope }));
  if (!order) throw AppError.notFound("Order not found.");
  return order;
}

export async function orderReturns(req, res) {
  const order = await ownOrder(req);
  const [eligibility, list] = await Promise.all([
    returns.returnEligibility(order),
    ReturnRequest.find({ order: order._id }).sort({ createdAt: -1 }),
  ]);
  ok(res, { eligibility, returns: list.map(returns.customerReturnView) });
}

export async function requestReturn(req, res) {
  const order = await ownOrder(req);
  const rr = await returns.createReturn({ order, owner: req.owner, input: req.valid.body, ip: req.ip });
  created(res, returns.customerReturnView(rr));
}

export async function cancelReturn(req, res) {
  const scope = scopeOf(req.owner);
  const rr = scope && (await ReturnRequest.findOne({ returnNumber: String(req.params.returnNumber).toUpperCase(), ...scope }));
  if (!rr) throw AppError.notFound("Return request not found.");
  ok(res, returns.customerReturnView(await returns.cancelByCustomer(rr, req.owner)));
}

/* Photo for a return request. Only customers with a delivered order can upload, into returns/return-evidence.
   Photos never attached to a request are removed by the orphan-upload cleanup job. */
export async function uploadEvidence(req, res) {
  const scope = scopeOf(req.owner);
  if (!scope || !(await Order.exists({ ...scope, status: "delivered" }))) throw AppError.forbidden("Photos can be added to returns for delivered orders only.");
  if (!req.file) throw AppError.badRequest("Choose a photo to upload (form field \"file\").");
  const up = await uploadImage(req.file, "returnEvidence", req.owner.userId ? { _id: req.owner.userId } : null);
  await audit("upload.created", { actor: req.owner.userId, entity: "Upload", entityId: up.publicId, ip: req.ip, meta: { kind: up.kind, bytes: up.bytes, guest: !req.owner.userId } });
  created(res, { url: up.url, publicId: up.publicId, width: up.width, height: up.height });
}
