/* Every successful response is { success: true, data, meta? }; errors are { success: false, error } (see errorHandler). */
export const ok = (res, data, meta, status = 200) => res.status(status).json(meta ? { success: true, data, meta } : { success: true, data });
export const created = (res, data) => ok(res, data, undefined, 201);

/* Parses ?page=&limit= into skip/limit with an upper bound, and builds the meta block. */
export function paginate({ page = 1, limit = 20 } = {}, maxLimit = 100) {
  const p = Math.max(1, Math.floor(Number(page)) || 1);
  const l = Math.min(maxLimit, Math.max(1, Math.floor(Number(limit)) || 20));
  return { page: p, limit: l, skip: (p - 1) * l, meta: (total) => ({ page: p, limit: l, total, pages: Math.ceil(total / l) }) };
}
