import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { authenticate, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { listUsers } from "../controllers/adminUserController.js";
import * as customers from "../controllers/admin/customersAdmin.js";
import * as catalog from "../controllers/admin/catalogAdmin.js";
import * as orders from "../controllers/admin/ordersAdmin.js";
import * as site from "../controllers/admin/siteAdmin.js";
import { crud } from "../controllers/admin/crud.js";
import { Coupon } from "../models/commerce.js";
import { Banner, ContactMessage, HomepageSection, Page, Popup } from "../models/site.js";
import { MAX_UPLOAD_BYTES } from "../services/uploadService.js";
import { listUsersQuery } from "../validators/userValidators.js";
import { userStatusSchema } from "../validators/accountValidators.js";
import { objectId } from "../validators/common.js";
import { adminProductsQuery, bulkProductsSchema, createCategorySchema, createProductSchema, listCategoriesQuery, stockAdjustSchema, updateCategorySchema, updateProductSchema } from "../validators/catalogValidators.js";
import { adminOrdersQuery, cancelSchema, createCouponSchema, listQuery, refundSchema, transactionsQuery, updateCouponSchema, updateFulfilmentSchema, updateOrderStatusSchema } from "../validators/commerceValidators.js";
import { contactStatusSchema, createBannerSchema, createPageSchema, createPopupSchema, createSectionSchema, notFoundRedirectSchema, reorderSchema, updateBannerSchema, updatePageSchema, updatePopupSchema, updateSectionSchema } from "../validators/contentValidators.js";
import { authRouter } from "./authRoutes.js";

const router = Router();
router.use("/auth", authRouter("admin"));

// Everything below requires an admin session (admin cookie + admin role, re-checked per request).
router.use(authenticate("admin"), requireRole("admin"));

const id = validate({ params: z.object({ id: objectId }).passthrough() });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } });

/** Mounts list/get/create/update/delete for a simple resource. */
function resource(path, controller, { create, update, guard = [] }) {
  router.get(path, validate({ query: listQuery }), controller.list);
  router.get(`${path}/:id`, id, controller.get);
  router.post(path, validate({ body: create }), ...guard, controller.create);
  router.patch(`${path}/:id`, id, validate({ body: update }), ...guard, controller.update);
  router.delete(`${path}/:id`, id, controller.remove);
}

/* Dashboard */
router.get("/dashboard", site.dashboard);

/* Customers */
router.get("/users", validate({ query: listUsersQuery }), listUsers);
router.get("/users/:id", id, customers.getCustomer);
router.patch("/users/:id/status", id, validate({ body: userStatusSchema }), customers.setStatus);
router.get("/wishlists", customers.wishlistStats);

/* Categories */
router.get("/categories", validate({ query: listCategoriesQuery }), catalog.listCategories);
router.get("/categories/tree", catalog.categoryTree);
router.post("/categories", validate({ body: createCategorySchema }), catalog.createCategory);
router.patch("/categories/:id", id, validate({ body: updateCategorySchema }), catalog.updateCategory);
router.delete("/categories/:id", id, catalog.deleteCategory);

/* Products & inventory */
router.get("/products", validate({ query: adminProductsQuery }), catalog.listProducts);
router.get("/products/export.csv", catalog.exportProducts);
router.post("/products/bulk", validate({ body: bulkProductsSchema }), catalog.bulkProducts);
router.get("/products/:id", id, catalog.getProduct);
router.post("/products", validate({ body: createProductSchema }), catalog.createProduct);
router.patch("/products/:id", id, validate({ body: updateProductSchema }), catalog.updateProduct);
router.delete("/products/:id", id, catalog.deleteProduct);
router.post("/products/:id/stock", id, validate({ body: stockAdjustSchema }), catalog.adjustStock);
router.get("/inventory/movements", catalog.inventoryMovements);

/* Orders & transactions */
router.get("/orders", validate({ query: adminOrdersQuery }), orders.listOrders);
router.get("/orders/:id", id, orders.getOrder);
router.get("/orders/:id/invoice", id, orders.invoice);
router.patch("/orders/:id/status", id, validate({ body: updateOrderStatusSchema }), orders.updateStatus);
router.patch("/orders/:id/fulfilment", id, validate({ body: updateFulfilmentSchema }), orders.updateFulfilment);
router.post("/orders/:id/cancel", id, validate({ body: cancelSchema }), orders.cancel);
router.post("/orders/:id/refund", id, validate({ body: refundSchema }), orders.refund);
router.get("/transactions", validate({ query: transactionsQuery }), orders.listTransactions);

/* Coupons */
resource("/coupons", crud(Coupon, { entity: "Coupon", searchFields: ["code", "description"] }), { create: createCouponSchema, update: updateCouponSchema, guard: [site.couponGuard] });

/* Manage Site */
router.get("/site-settings", site.allSettings);
router.patch("/site-settings/:section", site.updateSettings);
router.post("/site-settings/:section/reset", site.resetSettings);
router.post("/seo/sitemap/generate", site.generateSeoSitemap);
router.post("/seo/sitemap/upload", upload.single("file"), site.uploadSeoSitemap);
router.get("/seo/404-logs", validate({ query: listQuery }), site.seo404Logs);
router.patch("/seo/404-logs/:id", id, validate({ body: notFoundRedirectSchema }), site.updateSeo404Redirect);
router.delete("/seo/404-logs/:id", id, site.deleteSeo404Log);
resource("/banners", crud(Banner, { entity: "Banner", searchFields: ["title", "subtitle"], imageFields: ["image", "mobileImage"], sort: { placement: 1, order: 1 } }), { create: createBannerSchema, update: updateBannerSchema });
router.put("/homepage-sections/order", validate({ body: reorderSchema }), site.reorderSections);
resource("/homepage-sections", crud(HomepageSection, { entity: "HomepageSection", searchFields: ["title"], sort: { order: 1 } }), { create: createSectionSchema, update: updateSectionSchema });
resource("/popups", crud(Popup, { entity: "Popup", searchFields: ["title", "description"], imageFields: ["image"] }), { create: createPopupSchema, update: updatePopupSchema });
resource("/pages", crud(Page, { entity: "Page", searchFields: ["title", "slug"], sort: { title: 1 } }), { create: createPageSchema, update: updatePageSchema });

/* Uploads (Cloudinary) */
router.post("/uploads", upload.single("file"), site.upload);
router.delete("/uploads/*publicId", (req, _res, next) => { req.params.publicId = [].concat(req.params.publicId).join("/"); next(); }, site.discardUpload);

/* Messages, newsletter, audit */
const messages = crud(ContactMessage, { entity: "ContactMessage", searchFields: ["name", "phone", "email", "message", "orderNumber"] });
router.get("/contact-messages", validate({ query: listQuery }), messages.list);
router.patch("/contact-messages/:id", id, validate({ body: contactStatusSchema }), messages.update);
router.get("/newsletter", site.newsletterList);
router.get("/newsletter/export.csv", site.newsletterExport);
router.get("/audit-logs", site.auditLogs);

export default router;
