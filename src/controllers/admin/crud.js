import { audit } from "../../models/AuditLog.js";
import { AppError } from "../../utils/AppError.js";
import { created, ok, paginate } from "../../utils/respond.js";
import { escapeRegex } from "../../validators/common.js";
import { imageIds, releaseImages, resolveImageKeeping } from "../../services/uploadService.js";

/* Admin CRUD for simple resources. `imageFields` are resolved against the upload registry and
   replaced Cloudinary assets are deleted once unreferenced. Every change is audit-logged. */
export function crud(Model, { entity, searchFields = ["title"], imageFields = [], sort = { createdAt: -1 }, filters = () => ({}) }) {
  async function prepare(body, doc) {
    const data = { ...body };
    for (const f of imageFields) {
      if (data[f] !== undefined) data[f] = await resolveImageKeeping(data[f], doc?.[f]?.toObject?.() ?? doc?.[f]);
    }
    return data;
  }
  const load = async (id) => {
    const doc = await Model.findById(id);
    if (!doc) throw AppError.notFound(`${entity} not found.`);
    return doc;
  };
  return {
    async list(req, res) {
      const q = req.valid?.query || req.query;
      const { skip, limit, meta } = paginate(q, 200);
      const filter = { ...filters(q) };
      if (q.q) filter.$or = searchFields.map((f) => ({ [f]: new RegExp(escapeRegex(String(q.q)), "i") }));
      if (q.status) filter.status = String(q.status);
      const [items, total] = await Promise.all([Model.find(filter).sort(sort).skip(skip).limit(limit), Model.countDocuments(filter)]);
      ok(res, items, meta(total));
    },
    async get(req, res) { ok(res, await load(req.params.id)); },
    async create(req, res) {
      const doc = await Model.create(await prepare(req.valid.body));
      await audit(`${entity.toLowerCase()}.created`, { actor: req.auth.user._id, entity, entityId: doc._id, ip: req.ip });
      created(res, doc);
    },
    async update(req, res) {
      const doc = await load(req.params.id);
      const old = imageIds(...imageFields.map((f) => doc[f]));
      Object.assign(doc, await prepare(req.valid.body, doc));
      await doc.save();
      await audit(`${entity.toLowerCase()}.updated`, { actor: req.auth.user._id, entity, entityId: doc._id, ip: req.ip, meta: { fields: Object.keys(req.valid.body) } });
      await releaseImages(old.filter((id) => !imageIds(...imageFields.map((f) => doc[f])).includes(id)));
      ok(res, doc);
    },
    async remove(req, res) {
      const doc = await load(req.params.id);
      await doc.deleteOne();
      await audit(`${entity.toLowerCase()}.deleted`, { actor: req.auth.user._id, entity, entityId: doc._id, ip: req.ip });
      await releaseImages(imageIds(...imageFields.map((f) => doc[f])));
      ok(res, { deleted: true });
    },
  };
}
