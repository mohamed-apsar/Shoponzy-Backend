import * as returns from "../../services/returnService.js";
import { ok, paginate } from "../../utils/respond.js";
import { audit } from "../../models/AuditLog.js";
import { MAX_EXPORT_ROWS, csvDate, sendCsv } from "../../utils/csv.js";

export async function list(req, res) {
  const { skip, limit, meta } = paginate(req.valid.query);
  const { items, total } = await returns.listReturns(req.valid.query, { skip, limit });
  ok(res, items, meta(total));
}

export const summary = async (req, res) => ok(res, await returns.returnSummary(req.valid.query));

export async function items(req, res) {
  const { skip, limit, meta } = paginate(req.valid.query);
  const { items: rows, total } = await returns.listReturnedItems(req.valid.query, { skip, limit });
  ok(res, rows, meta(total));
}

export const get = async (req, res) => ok(res, await returns.getReturnDetail(req.params.id));

const act = (fn) => async (req, res) => {
  await fn(req.params.id, req.valid.body, req.auth.user);
  ok(res, await returns.getReturnDetail(req.params.id));
};
export const approve = act(returns.approve);
export const reject = act(returns.reject);
export const setStatus = act(returns.setStatus);
export const inspect = act(returns.inspect);
export const refund = act(returns.refund);

/* Return reasons offered to customers (admin-managed). */
export async function getReasons(_req, res) {
  const [reasons, usage] = await Promise.all([returns.getReturnReasons(), returns.reasonUsage()]);
  ok(res, reasons.map((r) => ({ ...r, used: usage[r.code] || 0 })));
}

export async function updateReasons(req, res) {
  const reasons = await returns.updateReturnReasons(req.valid.body.reasons, req.auth.user);
  const usage = await returns.reasonUsage();
  ok(res, reasons.map((r) => ({ ...r, used: usage[r.code] || 0 })));
}

/* ---------- CSV exports (same filters as the Returns pages) ---------- */
const today = () => new Date().toISOString().slice(0, 10);
const logExport = (req, action, rows) => audit(action, { actor: req.auth.user._id, entity: "ReturnRequest", ip: req.ip, meta: { rows, filters: req.valid?.query } });

export async function exportReturns(req, res) {
  const { items: list } = await returns.listReturns(req.valid.query, { skip: 0, limit: MAX_EXPORT_ROWS });
  const rows = [["return_id", "order_id", "customer", "customer_phone", "customer_email", "products", "skus", "quantity", "reason", "comments", "request_date", "return_status", "decision_date", "received_date", "inspected_date", "completed_date", "refund_status", "refund_amount", "refund_id"]];
  for (const r of list) {
    rows.push([r.returnNumber, r.orderNumber, r.customer?.name, r.customer?.phone, r.customer?.email,
      r.items.map((i) => `${i.name}${[i.color, i.size].filter(Boolean).length ? ` (${[i.color, i.size].filter(Boolean).join(" / ")})` : ""} x${i.qty}`).join("; "),
      r.items.map((i) => i.sku).filter(Boolean).join("; "), r.quantity, r.reasonLabel, r.comments, csvDate(r.createdAt), r.status,
      csvDate(r.decidedAt), csvDate(r.receivedAt), csvDate(r.inspectedAt), csvDate(r.completedAt), r.refund.status, r.refund.amount ?? "", r.refund.refundId || ""]);
  }
  await logExport(req, "returns.exported", list.length);
  sendCsv(res, `shoponzy-returns${req.valid.query.view ? `-${req.valid.query.view}` : req.valid.query.status ? `-${req.valid.query.status}` : ""}-${today()}.csv`, rows);
}

export async function exportReturnedItems(req, res) {
  const { items: list } = await returns.listReturnedItems(req.valid.query, { skip: 0, limit: MAX_EXPORT_ROWS });
  const rows = [["product", "variant", "sku", "quantity", "order_id", "return_id", "customer", "request_date", "approval_date", "received_date", "inspected_date", "condition", "restocked_qty", "inspection_notes", "return_status"]];
  for (const i of list) {
    rows.push([i.name, i.variant, i.sku, i.qty, i.orderNumber, i.returnNumber, i.customer, csvDate(i.requestedAt), csvDate(i.approvedAt), csvDate(i.receivedAt), csvDate(i.inspectedAt),
      i.condition || "not inspected", i.condition ? i.restockedQty : "", i.inspectionNotes, i.status]);
  }
  await logExport(req, "returns.items_exported", list.length);
  sendCsv(res, `shoponzy-returned-products-${today()}.csv`, rows);
}

export async function exportReasons(req, res) {
  const [reasons, usage] = await Promise.all([returns.getReturnReasons(), returns.reasonUsage()]);
  const rows = [["position", "reason", "code", "shown_to_customers", "comment_required", "return_requests"]];
  reasons.forEach((r, i) => rows.push([i + 1, r.label, r.code, r.active ? "yes" : "no", r.requiresComment ? "yes" : "no", usage[r.code] || 0]));
  await logExport(req, "returns.reasons_exported", reasons.length);
  sendCsv(res, `shoponzy-return-reasons-${today()}.csv`, rows);
}
