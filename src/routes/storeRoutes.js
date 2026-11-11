import { Router } from "express";
import * as catalog from "../controllers/catalogController.js";
import * as site from "../controllers/siteController.js";
import * as cart from "../controllers/cartController.js";
import * as orders from "../controllers/orderController.js";
import * as account from "../controllers/accountController.js";
import * as returns from "../controllers/returnController.js";
import multer from "multer";
import { UPLOAD_KINDS } from "../services/uploadService.js";
import { createReturnSchema } from "../validators/returnValidators.js";
import { authenticate, optionalAuth } from "../middleware/auth.js";
import { cartOwner } from "../middleware/cartOwner.js";
import { validate } from "../middleware/validate.js";
import { formLimiter, checkoutLimiter, trackLimiter, loginIpLimiter, returnUploadLimiter } from "../middleware/rateLimits.js";
import { idsQuery, publicProductsQuery } from "../validators/catalogValidators.js";
import { contactSchema, newsletterSchema, notFoundTrackSchema } from "../validators/contentValidators.js";
import { addCartItemSchema, addressSchema, cancelSchema, checkoutSchema, couponSchema, myOrdersQuery, trackOrderSchema, updateCartItemSchema, verifyPaymentSchema } from "../validators/commerceValidators.js";
import { changePasswordSchema, deleteAccountSchema, forgotPasswordSchema, profileSchema, resetPasswordSchema, wishlistAddSchema, wishlistMergeSchema } from "../validators/accountValidators.js";
import { objectId } from "../validators/common.js";
import { z } from "zod";

const r = Router();
const idParam = (name) => validate({ params: z.object({ [name]: objectId }).passthrough() });

/* ---------- Catalogue & content (public) ---------- */
r.get("/site-settings", site.settings);
r.get("/homepage", site.homepage);
r.get("/banners", site.banners);
r.get("/popups", site.popups);
r.get("/pages", site.pages);
r.get("/pages/:slug", site.pageBySlug);
r.get("/categories", catalog.categoryTree);
r.get("/categories/{*path}", (req, _res, next) => { req.params.path = [].concat(req.params.path).join("/"); next(); }, catalog.categoryByPath);
r.get("/products", validate({ query: publicProductsQuery }), catalog.listProducts);
r.get("/products/by-ids", validate({ query: idsQuery }), catalog.productsByIds);
r.get("/products/legacy/:legacyId", catalog.legacyLookup);
r.get("/products/:slug", catalog.productBySlug);
r.get("/products/:id/related", idParam("id"), catalog.relatedProducts);
r.get("/seo/sitemap.xml", site.sitemap);
r.get("/seo/robots.txt", site.robots);
r.post("/seo/404", validate({ body: notFoundTrackSchema }), site.trackNotFound);
r.post("/contact", formLimiter, optionalAuth("customer"), validate({ body: contactSchema }), site.contact);
r.post("/newsletter", formLimiter, validate({ body: newsletterSchema }), site.newsletter);
r.get("/newsletter/unsubscribe", site.unsubscribePage);
r.post("/newsletter/unsubscribe", formLimiter, site.unsubscribe);
r.get("/faqs", site.faqs);

/* ---------- Cart (guests and customers) ---------- */
r.get("/cart", optionalAuth("customer"), cartOwner(), cart.getCart);
// Validation runs first so invalid requests never create a guest bag.
r.post("/cart/items", validate({ body: addCartItemSchema }), optionalAuth("customer"), cartOwner({ create: true }), cart.addItem);
r.patch("/cart/items/:itemId", idParam("itemId"), validate({ body: updateCartItemSchema }), optionalAuth("customer"), cartOwner(), cart.updateItem);
r.delete("/cart/items/:itemId", idParam("itemId"), optionalAuth("customer"), cartOwner(), cart.removeItem);
r.get("/coupons", cart.couponOffers);
r.get("/coupons/:code", trackLimiter, validate({ params: z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/, "Check the code.") }) }), cart.couponInfo);
r.put("/cart/coupon",validate({ body: couponSchema }), optionalAuth("customer"), cartOwner({ create: true }), cart.setCoupon);

/* ---------- Orders & payments ---------- */
r.post("/orders", checkoutLimiter, optionalAuth("customer"), cartOwner(), validate({ body: checkoutSchema }), orders.checkout);
r.post("/orders/track", trackLimiter, validate({ body: trackOrderSchema }), orders.track);
r.get("/orders", authenticate("customer"), cartOwner(), validate({ query: myOrdersQuery }), orders.myOrders);
r.get("/orders/:orderNumber", optionalAuth("customer"), cartOwner(), orders.myOrder);
r.post("/orders/:orderNumber/cancel", optionalAuth("customer"), cartOwner(), validate({ body: cancelSchema }), orders.cancelMyOrder);
/* ---------- Returns (own orders: signed-in customer, or the guest browser that ordered) ---------- */
const evidenceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: UPLOAD_KINDS.returnEvidence.maxBytes, files: 1, fields: 2 } });
r.get("/orders/:orderNumber/returns", optionalAuth("customer"), cartOwner(), returns.orderReturns);
r.post("/orders/:orderNumber/returns", formLimiter, optionalAuth("customer"), cartOwner(), validate({ body: createReturnSchema }), returns.requestReturn);
r.post("/returns/uploads", returnUploadLimiter, optionalAuth("customer"), cartOwner(), evidenceUpload.single("file"), returns.uploadEvidence);
r.post("/returns/:returnNumber/cancel", optionalAuth("customer"), cartOwner(), returns.cancelReturn);
r.post("/payments/razorpay/verify", checkoutLimiter, validate({ body: verifyPaymentSchema }), orders.verifyRazorpay);
r.post("/payments/webhook", orders.razorpayWebhook);

/* ---------- Password reset (public) ---------- */
r.post("/auth/forgot-password", loginIpLimiter, validate({ body: forgotPasswordSchema }), account.forgotPassword);
r.post("/auth/reset-password", loginIpLimiter, validate({ body: resetPasswordSchema }), account.resetPassword);

/* ---------- Account (signed-in customers) ---------- */
const acct = Router();
acct.use(authenticate("customer"));
acct.patch("/profile", validate({ body: profileSchema }), account.updateProfile);
acct.post("/password", loginIpLimiter, validate({ body: changePasswordSchema }), account.changePassword);
acct.post("/delete", loginIpLimiter, validate({ body: deleteAccountSchema }), account.deleteAccount);
acct.get("/addresses", account.addresses);
acct.post("/addresses", validate({ body: addressSchema }), account.addAddress);
acct.patch("/addresses/:addressId", idParam("addressId"), validate({ body: addressSchema.partial() }), account.updateAddress);
acct.delete("/addresses/:addressId", idParam("addressId"), account.removeAddress);
acct.get("/wishlist", account.wishlist);
acct.post("/wishlist", validate({ body: wishlistAddSchema }), account.addToWishlist);
acct.post("/wishlist/merge", validate({ body: wishlistMergeSchema }), account.mergeWishlist);
acct.delete("/wishlist/:productId", idParam("productId"), account.removeFromWishlist);
r.use("/account", acct);

export default r;
