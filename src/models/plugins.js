/* JSON output: `id` instead of `_id`, no `__v`, and any field listed in `hidden` removed. */
export function toJSONPlugin(schema, { hidden = [] } = {}) {
  schema.set("toJSON", {
    virtuals: true,
    versionKey: false,
    transform(_doc, ret) {
      ret.id = String(ret._id);
      delete ret._id;
      for (const key of hidden) delete ret[key];
      return ret;
    },
  });
}
