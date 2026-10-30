import { User } from "../models/User.js";
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
