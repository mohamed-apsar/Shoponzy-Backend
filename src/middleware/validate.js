/* validate({ body, query, params }) — each a zod schema. Parsed (coerced, stripped) values are
   placed on req.valid; Express 5 makes req.query read-only, so originals are left untouched. */
export const validate = (schemas) => (req, _res, next) => {
  req.valid = {};
  for (const part of ["params", "query", "body"]) {
    if (!schemas[part]) continue;
    req.valid[part] = schemas[part].parse(req[part] ?? {});
  }
  next();
};
