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
