import { beforeEach, expect, it } from "vitest";
import { browser, useDb } from "./helpers.js";
import { adminBrowser, category } from "./fixtures.js";
import { Category } from "../src/models/Category.js";

useDb();
let admin;
beforeEach(async () => { admin = await adminBrowser(); });

it("persists homepage toggles and exposes changes through the public category tree", async () => {
  const root = await category("Shoes");
  const child = await category("Sneakers", root);
  const visitor = await browser();
  const read = async () => (await visitor.get("/categories").expect(200)).body.data.find((c) => c.id === String(root._id)).children[0];
  expect((await read()).showOnHomepage).toBe(false);
  await admin.patch(`/admin/categories/${child._id}`, { showOnHomepage: true }).expect(200);
  expect((await Category.findById(child._id)).showOnHomepage).toBe(true);
  expect((await read()).showOnHomepage).toBe(true);
  await admin.patch(`/admin/categories/${child._id}`, { name: "New Sneakers" }).expect(200);
  expect((await read()).showOnHomepage).toBe(true);
  await admin.patch(`/admin/categories/${child._id}`, { showOnHomepage: false }).expect(200);
  expect((await read()).showOnHomepage).toBe(false);
  await visitor.patch(`/admin/categories/${child._id}`, { showOnHomepage: true }).expect(401);
  await admin.patch(`/admin/categories/${child._id}`, { showOnHomepage: "true" }).expect(400);
});

it("does not expose selected subcategories beneath disabled parents", async () => {
  const root = await category("Shoes");
  const child = await category("Sneakers", root);
  await admin.patch(`/admin/categories/${child._id}`, { showOnHomepage: true }).expect(200);
  await admin.patch(`/admin/categories/${root._id}`, { status: "disabled" }).expect(200);
  expect((await (await browser()).get("/categories").expect(200)).body.data).toEqual([]);
});
