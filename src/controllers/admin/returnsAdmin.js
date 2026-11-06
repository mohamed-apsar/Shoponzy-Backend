import * as returns from "../../services/returnService.js";
import { ok, paginate } from "../../utils/respond.js";

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
