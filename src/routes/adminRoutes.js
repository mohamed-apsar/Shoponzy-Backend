import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { authenticate, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { exportUsers, listUsers } from "../controllers/adminUserController.js";
import * as customers from "../controllers/admin/customersAdmin.js";
import * as catalog from "../controllers/admin/catalogAdmin.js";
import * as orders from "../controllers/admin/ordersAdmin.js";
import * as site from "../controllers/admin/siteAdmin.js";
import * as inventory from "../controllers/admin/inventoryAdmin.js";
import * as returnsAdmin from "../controllers/admin/returnsAdmin.js";
import * as engagement from "../controllers/admin/engagementAdmin.js";
import { campaignListQuery, createCampaignSchema, createFaqSchema, emailLogQuery, faqListQuery, notificationSettingsSchema, reorderIdsSchema, supportListQuery, supportNoteSchema, supportReplySchema, supportStatusSchema, testSendSchema, updateCampaignSchema, updateFaqSchema } from "../validators/engagementValidators.js";
import { adminReturnsQuery, approveReturnSchema, inspectReturnSchema, rejectReturnSchema, returnReasonsSchema, returnRefundSchema, returnStatusSchema, returnSummaryQuery } from "../validators/returnValidators.js";
import { crud } from "../controllers/admin/crud.js";
import { Coupon } from "../models/commerce.js";
import { Banner, HomepageSection, Page, Popup } from "../models/site.js";
import { MAX_UPLOAD_BYTES } from "../services/uploadService.js";
import { listUsersQuery } from "../validators/userValidators.js";
import { inventoryQuery, inventorySettingsSchema, movementsQuery, productThresholdSchema } from "../validators/inventoryValidators.js";
import { changeAdminCredentialsSchema, changeAdminEmailSchema, changePasswordSchema, userStatusSchema } from "../validators/accountValidators.js";
import * as account from "../services/accountService.js";
import { loginIpLimiter } from "../middleware/rateLimits.js";
import { audit } from "../models/AuditLog.js";
import { ok } from "../utils/respond.js";
import { objectId } from "../validators/common.js";
import { adminProductsQuery, bulkProductsSchema, createCategorySchema, createProductSchema, listCategoriesQuery, stockAdjustSchema, updateCategorySchema, updateProductSchema } from "../validators/catalogValidators.js";
import { adminOrdersQuery, cancelSchema, createCouponSchema, listQuery, refundSchema, refundsQuery, transactionsQuery, updateCouponSchema, updateFulfilmentSchema, updateOrderStatusSchema } from "../validators/commerceValidators.js";
import { createBannerSchema, createPageSchema, createPopupSchema, createSectionSchema, notFoundRedirectSchema, reorderSchema, updateBannerSchema, updatePageSchema, updatePopupSchema, updateSectionSchema } from "../validators/contentValidators.js";
import { authRouter } from "./authRoutes.js";

const router = Router();
router.use("/auth", authRouter("admin"));

// Everything below requires an admin session (admin cookie + admin role, re-checked per request).
router.use(authenticate("admin"), requireRole("admin"));

router.post("/auth/password", loginIpLimiter, validate({ body: changePasswordSchema }), async (req, res) => {
  await account.changePassword(req.auth.user._id, req.valid.body, req.auth.sessionId);
  await audit("auth.admin_password_changed", { actor: req.auth.user._id, entity: "User", entityId: req.auth.user._id, ip: req.ip });
  ok(res, { changed: true });
});
router.post("/auth/email", loginIpLimiter, validate({ body: changeAdminEmailSchema }), async (req, res) => {
  const user = await account.changeAdminEmail(req.auth.user._id, req.valid.body, req.auth.sessionId);
  await audit("auth.admin_email_changed", { actor: req.auth.user._id, entity: "User", entityId: req.auth.user._id, ip: req.ip });
  ok(res, { user });
});
router.post("/auth/credentials", loginIpLimiter, validate({ body: changeAdminCredentialsSchema }), async (req, res) => {
  const user = await account.changeAdminCredentials(req.auth.user._id, req.valid.body, req.auth.sessionId);
  await audit("auth.admin_credentials_changed", { actor: req.auth.user._id, entity: "User", entityId: req.auth.user._id, ip: req.ip });
  ok(res, { user });
});

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
router.get("/users/export.csv", validate({ query: listUsersQuery }), exportUsers);
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
router.patch("/products/:id/low-stock-threshold", id, validate({ body: productThresholdSchema }), inventory.setProductThreshold);

/* Inventory Management (stock lives on product variants; history is the InventoryMovement log) */
router.get("/inventory", validate({ query: inventoryQuery }), inventory.list);
router.get("/inventory/summary", inventory.summary);
router.get("/inventory/export.csv", validate({ query: inventoryQuery }), inventory.exportStock);
router.get("/inventory/settings", inventory.getSettings);
router.put("/inventory/settings", validate({ body: inventorySettingsSchema }), inventory.updateSettings);
router.get("/inventory/movements", validate({ query: movementsQuery }), inventory.movements);
router.get("/inventory/movements/export.csv", validate({ query: movementsQuery }), inventory.exportMovements);

/* Orders & transactions */
router.get("/orders", validate({ query: adminOrdersQuery }), orders.listOrders);
router.get("/orders/:id", id, orders.getOrder);
router.get("/orders/:id/invoice", id, orders.invoice);
router.patch("/orders/:id/status", id, validate({ body: updateOrderStatusSchema }), orders.updateStatus);
router.patch("/orders/:id/fulfilment", id, validate({ body: updateFulfilmentSchema }), orders.updateFulfilment);
router.post("/orders/:id/cancel", id, validate({ body: cancelSchema }), orders.cancel);
router.post("/orders/:id/refund", id, validate({ body: refundSchema }), orders.refund);
router.get("/transactions", validate({ query: transactionsQuery }), orders.listTransactions);
router.get("/transactions/summary", validate({ query: transactionsQuery }), orders.transactionSummary);
router.get("/transactions/export.csv", validate({ query: transactionsQuery }), orders.exportTransactions);
router.get("/transactions/methods.csv", validate({ query: transactionsQuery }), orders.exportMethods);
router.get("/transactions/:id", id, orders.getTransaction);
router.post("/transactions/:id/refunds/:refundId/sync", id, validate({ params: z.object({ id: objectId, refundId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,80}$/) }) }), orders.syncRefund);
router.get("/refunds", validate({ query: refundsQuery }), orders.listRefunds);
router.get("/refunds/export.csv", validate({ query: refundsQuery }), orders.exportRefunds);

/* Returns & refunds */
router.get("/returns", validate({ query: adminReturnsQuery }), returnsAdmin.list);
router.get("/returns/summary", validate({ query: returnSummaryQuery }), returnsAdmin.summary);
router.get("/returns/items", validate({ query: adminReturnsQuery }), returnsAdmin.items);
router.get("/returns/reasons", returnsAdmin.getReasons);
router.get("/returns/reasons.csv", returnsAdmin.exportReasons);
router.get("/returns/export.csv", validate({ query: adminReturnsQuery }), returnsAdmin.exportReturns);
router.get("/returns/items/export.csv", validate({ query: adminReturnsQuery }), returnsAdmin.exportReturnedItems);
router.put("/returns/reasons", validate({ body: returnReasonsSchema }), returnsAdmin.updateReasons);
router.get("/returns/:id", id, returnsAdmin.get);
router.post("/returns/:id/approve", id, validate({ body: approveReturnSchema }), returnsAdmin.approve);
router.post("/returns/:id/reject", id, validate({ body: rejectReturnSchema }), returnsAdmin.reject);
router.post("/returns/:id/status", id, validate({ body: returnStatusSchema }), returnsAdmin.setStatus);
router.post("/returns/:id/inspect", id, validate({ body: inspectReturnSchema }), returnsAdmin.inspect);
router.post("/returns/:id/refund", id, validate({ body: returnRefundSchema }), returnsAdmin.refund);

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

/* FAQ Management */
router.get("/faqs", validate({ query: faqListQuery }), engagement.listFaqs);
router.get("/faqs/export.csv", engagement.exportFaqs);
router.post("/faqs", validate({ body: createFaqSchema }), engagement.createFaq);
router.post("/faqs/import-defaults", engagement.importDefaultFaqs);
router.put("/faqs/order", validate({ body: reorderIdsSchema }), engagement.reorderFaqs);
router.patch("/faqs/:id", id, validate({ body: updateFaqSchema }), engagement.updateFaq);
router.delete("/faqs/:id", id, engagement.deleteFaq);

/* Notifications (promotional emails to newsletter subscribers + order/return email switches) */
router.get("/notifications/summary", engagement.notificationSummary);
router.get("/notifications/settings", engagement.getNotificationSettings);
router.put("/notifications/settings", validate({ body: notificationSettingsSchema }), engagement.updateNotificationSettings);
router.get("/notifications/email-log", validate({ query: emailLogQuery }), engagement.emailLog);
router.get("/notifications/email-log/export.csv", validate({ query: emailLogQuery }), engagement.exportEmailLog);
router.get("/notifications/export.csv", validate({ query: campaignListQuery }), engagement.exportCampaigns);
router.get("/notifications", validate({ query: campaignListQuery }), engagement.listCampaigns);
router.post("/notifications", validate({ body: createCampaignSchema }), engagement.createCampaign);
router.get("/notifications/:id", id, engagement.getCampaign);
router.patch("/notifications/:id", id, validate({ body: updateCampaignSchema }), engagement.updateCampaign);
router.delete("/notifications/:id", id, engagement.deleteCampaign);
router.get("/notifications/:id/preview", id, engagement.previewCampaign);
router.post("/notifications/:id/test", id, validate({ body: testSendSchema }), engagement.sendTest);
router.post("/notifications/:id/send", id, engagement.sendBatch);
router.post("/notifications/:id/cancel", id, engagement.cancelCampaign);

/* Help & Support (storefront contact-form messages) */
router.get("/contact-messages", validate({ query: supportListQuery }), engagement.listSupport);
router.get("/contact-messages/export.csv", validate({ query: supportListQuery }), engagement.exportSupport);
router.get("/contact-messages/:id", id, engagement.getSupport);
router.patch("/contact-messages/:id", id, validate({ body: supportStatusSchema }), engagement.setSupportStatus);
router.post("/contact-messages/:id/reply", id, validate({ body: supportReplySchema }), engagement.replySupport);
router.post("/contact-messages/:id/notes", id, validate({ body: supportNoteSchema }), engagement.noteSupport);

/* Newsletter, audit */
router.get("/newsletter", site.newsletterList);
router.get("/newsletter/export.csv", site.newsletterExport);
router.get("/audit-logs", site.auditLogs);

export default router;
