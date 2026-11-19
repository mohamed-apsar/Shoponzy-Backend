/* Targeted cleanup of the unused T-Shirts > Round Neck category branch.
   node scripts/remove-tshirt-categories.js          inspect only
   node scripts/remove-tshirt-categories.js --apply  delete after dependency checks
   Other T-shirt categories, products and order history are left untouched. */
import { env } from "../src/config/env.js";
import mongoose from "mongoose";
import { Category } from "../src/models/Category.js";
import { Product } from "../src/models/Product.js";
import { deleteCategory } from "../src/services/categoryService.js";
import { audit } from "../src/models/AuditLog.js";

async function run() {
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  const root = await Category.findOne({ slug: "t-shirt", path: "t-shirt", parent: null, level: 1 });
  if (!root) {
    console.log("T-Shirts category is already absent. No changes needed.");
    return;
  }
  if (!/^t[ -]?shirts?$/i.test(root.name)) throw new Error("The category name changed; refusing to remove it.");
  const children = await Category.find({ parent: root._id });
  if (children.some((child) => child.slug !== "round-neck" || child.path !== "t-shirt/round-neck" || child.level !== 2 || !/^round[ -]?neck$/i.test(child.name))) {
    throw new Error("T-Shirts has additional or changed subcategories. No changes made.");
  }
  const targets = [...children, root];
  const ids = targets.map((category) => category._id);
  if (await Category.exists({ parent: { $in: children.map((child) => child._id) } })) {
    throw new Error("Round Neck has child categories. No changes made.");
  }
  if (await Product.exists({ categoryPath: { $in: ids }, status: { $ne: "archived" } })) {
    throw new Error("Products are still assigned to this branch. No changes made.");
  }
  console.log(JSON.stringify({ targets: targets.map(({ _id, name, path }) => ({ id: String(_id), name, path })), apply: process.argv.includes("--apply") }));
  if (!process.argv.includes("--apply")) return;
  for (const category of targets) {
    await deleteCategory(category._id);
    await audit("category.deleted", { entity: "Category", entityId: category._id, meta: { name: category.name, path: category.path, source: "requested_tshirt_cleanup" } });
    console.log(`Deleted ${category.name} (${category.path}).`);
  }
  if (await Category.exists({ _id: { $in: ids } })) throw new Error("Category cleanup verification failed.");
  console.log("Verified: T-Shirts and Round Neck are removed.");
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
