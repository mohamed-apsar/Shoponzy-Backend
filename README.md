# Shoponzy API

Express 5 + MongoDB (Mongoose 8) REST API shared by the storefront (`user-site/`) and the admin panel (`admin-panel/`). It covers catalogue, Cloudinary images, cart, checkout (COD + Razorpay), inventory, orders, refunds, customer accounts, Manage Site content, dashboard and SEO.

## Setup

```bash
npm install
cp .env.example .env          # fill in MONGODB_URI, JWT_SECRET, Cloudinary, Razorpay, SMTP (comments in the file)
npm run seed                  # loads the storefront's catalogue + content (safe to re-run)
npm run create-admin -- --email owner@shoponzy.in --name "Store Owner"   # prompts for a password (12+ chars)
npm run dev                   # http://localhost:5000/api/v1/health
npm test                      # in-memory MongoDB; no .env needed
```

- The server refuses to start if required settings are missing or weak (e.g. `JWT_SECRET` under 32 characters, or `COOKIE_SECURE=false` in production).
- The first `npm test` downloads a MongoDB binary (~600 MB, cached afterwards).
- `npm run seed -- --upload-images` also copies the 4 real product photos from the old WordPress host into Cloudinary; without the flag they stay as remote URLs.
- **The seed's stock is sample data** (20 per variant): the original site had none. Set real stock in the admin panel before launch.
- Chelsea boots were listed as "₹480–₹520"; the seed prices sizes 6–8 at ₹480 and 9–10 at ₹520. Confirm.

### Deploying to Vercel

Set the Vercel project's **Root Directory** to `backend`. The included `vercel.json` routes requests to an Express serverless handler, which connects to MongoDB on demand; the local `npm start` server and its background jobs remain unchanged.

Configure these production environment variables in the Vercel project before deploying:

- `MONGODB_URI`
- `JWT_SECRET` (at least 32 characters)
- `CLIENT_URL` and `ADMIN_URL` (the deployed storefront and admin origins)
- `COOKIE_SECURE=true`
- `NODE_ENV=production`

The production storefront and admin origins are allowed by default. Cross-site session cookies default to `SameSite=None` in production and require `COOKIE_SECURE=true`; if explicitly setting `COOKIE_SAMESITE`, use `none`. Add any additional browser origins to `CORS_EXTRA_ORIGINS`. Never commit `.env`; Vercel does not use the local environment file. Check the function logs for startup/configuration errors if deployment still fails. `GET /api/v1/health` should return `db: "connected"` when the database is available.

### Optional services and what happens without them

| Service | Env | Without it |
|---|---|---|
| Cloudinary | `CLOUDINARY_*` | `POST /admin/uploads` → 503 `UPLOADS_NOT_CONFIGURED`; everything else works |
| Razorpay | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Online-payment checkout → 503 `PAYMENTS_NOT_CONFIGURED` (before any stock is touched); COD works |
| SMTP email | `SMTP_HOST` … | Password reset → 503 `EMAIL_NOT_CONFIGURED`; order emails are skipped (orders still succeed) |

## Conventions

- Base path `/api/v1`. JSON only (plus CSV exports, the printable invoice, sitemap and robots).
- Success: `{ "success": true, "data": …, "meta"?: { page, limit, total, pages, … } }`
- Error: `{ "success": false, "error": { "code", "message", "details"?: [{ path, message }] } }`
- Lists take `?page=` (default 1) and `?limit=` (default 20, max 100).
- Money is in rupees (2 decimals max). Razorpay amounts are converted to paise internally.

| Status | Example `code`s |
|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_JSON`, `INVALID_ID`, `CART_EMPTY`, `INVALID_COUPON`, `COD_UNAVAILABLE`, `AMOUNT_MISMATCH`, `PAYMENT_VERIFICATION_FAILED`, `INVALID_RESET_LINK`, `WRONG_PASSWORD` |
| 401 / 403 | `UNAUTHORIZED` / `FORBIDDEN`, `CSRF_INVALID`, `BAD_ORIGIN` |
| 402 | `PAYMENT_NOT_CAPTURED` |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT`, `DUPLICATE`, `OUT_OF_STOCK`, `INSUFFICIENT_STOCK`, `CART_ISSUES`, `COUPON_INVALID`, `INVALID_TRANSITION`, `NOT_REFUNDABLE` |
| 413 / 415 | `PAYLOAD_TOO_LARGE`, `FILE_TOO_LARGE` / `UNSUPPORTED_FILE` |
| 429 | `RATE_LIMITED` |
| 502 / 503 | `UPLOAD_FAILED`, `PAYMENT_GATEWAY_ERROR`, `REFUND_FAILED` / `*_NOT_CONFIGURED` |
| 500 | `INTERNAL_ERROR` (details logged, never returned in production) |

## Security model

- **Sessions:** httpOnly cookies only.
  - Access JWT (15 min), checked against its session row on every request.
  - Refresh token (30 days), stored hashed and rotated on every use. A replayed rotated token revokes all of that user's sessions; a 10 s grace covers concurrent tabs.
- **Admin isolation:** admin and customer sessions use separate cookies (`sz_admin_*` vs `sz_*`) and JWT audiences. Admin routes re-check the role on every request.
- **CSRF:** every POST/PUT/PATCH/DELETE needs `X-CSRF-Token` matching the `sz_csrf` cookie (token from `GET /csrf`), and a browser `Origin` from the allow-list. The Razorpay webhook is exempt; it's authenticated by its HMAC signature instead.
- **Input:** every route parses input with a strict zod schema; unknown fields are rejected, so clients can't send `price`, `role`, `status` and so on. Queries only ever receive typed values.
- **Images:**
  - Only admins can upload.
  - The real file type is checked from its bytes: JPG, PNG, WebP, GIF, AVIF, and ICO for favicons only. SVG is never accepted.
  - Size limits apply per kind, and each kind uploads to a fixed Cloudinary folder.
  - Records can only reference images uploaded through this API.
- **Rate limits (per IP):** login 10 / 15 min (+20 / hour per account), register 10 / hour, password reset 10 / 15 min, checkout 30 / 15 min, order tracking 15 / 15 min, contact/newsletter 20 / hour, whole API 300 / min. Counters are in memory; with several instances, use a shared store.
- **Admins** are created only via `npm run create-admin`. Admin actions are written to `auditlogs` (`GET /admin/audit-logs`).

### Frontend usage

```js
const api = (path, opts = {}) => fetch(`${API_URL}/api/v1${path}`, {
  credentials: "include",
  headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken, ...opts.headers },
  ...opts,
});
// On load:  csrfToken = (await (await fetch(`${API_URL}/api/v1/csrf`, { credentials: "include" })).json()).data.csrfToken
// On 401:   POST /auth/refresh once (admin: /admin/auth/refresh), then retry; if that fails, show sign-in.
// Images:   Cloudinary URLs accept transformations, e.g. insert `f_auto,q_auto,w_600/` after `/upload/`.
```

## Business rules

- **Products** have colours, sizes and one variant per colour × size, each with its own SKU, price, MRP and stock. Each colour can have a featured image and additional gallery images; shared product images remain available as fallback/gallery media. Product detail pages can also have ordered wide banners and three-image rows. A product without options has one variant. Listing price, discount % and total stock are derived on save.
- **Categories** nest up to 5 levels. Moving or renaming a branch updates every descendant and every product's category path. Disabling a category hides its whole branch and its products from the storefront. A category with subcategories or products can't be deleted. Category images support circular category links, Shop all dropdown backgrounds, and category page banners.
- **Totals** are always computed on the server from database prices, in this order: subtotal → coupon → prepaid discount (`commerce.prepaidOffPct`, online payments only) → shipping (free when subtotal − coupon ≥ `freeShippingAbove`, else `shippingFee`). Prices are tax-inclusive.
- **Stock** changes only inside MongoDB transactions with conditional decrements, so concurrent buyers can't oversell. Every change writes an `InventoryMovement`.

| Event | Stock | Order status | Payment |
|---|---|---|---|
| COD checkout | taken | `placed` | `pending` (→ `paid` on delivery) |
| Razorpay checkout | reserved for `ORDER_RESERVATION_MINUTES` | `pending_payment` | `pending` |
| Payment verified (callback or webhook) | kept | `placed` | `paid` |
| Reservation expires unpaid | released (Razorpay is checked first, so a delayed payment is honoured) | `cancelled` | — |
| Paid after expiry | re-reserved if available; otherwise flagged `needsAttention` + `refundRequired` | `placed` / stays `cancelled` | `paid` |
| Cancel (customer: placed/confirmed; admin: up to packed) | returned | `cancelled` | paid → `refundRequired` |
| Return (admin) | returned (optional) | `returned` | paid → `refundRequired` |

- **Allowed admin transitions:** `placed → confirmed / packed / shipped / cancelled`, `confirmed → packed / shipped / cancelled`, `packed → shipped / cancelled`, `shipped → delivered / returned`, `delivered → returned`.
- **Refunds** are admin-only. Razorpay orders are refunded through the Razorpay API (partial or full); COD refunds record the bank/UPI reference. A payment counts as paid only when Razorpay reports it captured *and* the amount matches. A signed callback alone is not enough.
  - One refund per order at a time: the order is locked while the gateway call runs, so a double click can't refund twice.
  - A Razorpay refund stays `pending` until Razorpay reports `processed` (webhook `refund.processed`, or `POST /admin/transactions/:id/refunds/:refundId/sync`). On `refund.failed` the amount goes back to the order's refundable balance and the order is flagged `refundRequired`.
  - A late `payment.captured` webhook never turns a refunded payment back into "captured".
- **Manual stock changes** (`POST /admin/products/:id/stock`) need a written reason (`note`, min 3 characters). Each one records the mode (add / remove / set), the stock before and after, and the admin. `set` only applies if the stock hasn't changed in the meantime; `expectedStock` lets the UI refuse to save if it moved since the form opened.
- **Low stock** means an active variant with `0 < stock ≤ threshold`. The threshold is the product's `lowStockThreshold`, or else the store-wide `inventory.lowStockThreshold` setting (default `LOW_STOCK_THRESHOLD`; admin-only, never sent to the storefront).
- **Returns** (`RT100001`, …): customers request them for delivered orders within `commerce.returnDays` of delivery, per item and quantity (partial returns allowed).
  - Flow: `requested → approved → (pickup_scheduled → in_transit →) received → inspected → completed`. `requested → rejected` (reason required). `requested / approved / pickup_scheduled → cancelled`.
  - Stock goes back **only at inspection**, for the units the inspector restocks (never for `unsellable` items).
  - Approval makes a refund due (`pending`) on paid orders. It can be issued only after inspection, for at most what was paid for those items: line value minus a proportional share of coupon and prepaid discounts, excluding delivery.
  - Refund status: `not_applicable / pending / processing / completed / failed`; it follows Razorpay. A return can't be completed while its refund is outstanding.
  - When every unit of an order has come back through completed returns, the order becomes `returned` (without restocking a second time).
- **Idempotency:** checkout takes an `idempotencyKey` (one per checkout attempt; a resubmit returns the same order). Webhook events are processed once per event id.
- **Order numbers** are sequential: `SZ100001`, `SZ100002`, …

## Endpoints

### Public & storefront

| Method | Path | Notes |
|---|---|---|
| GET | `/health`, `/csrf` | |
| GET | `/site-settings` | All Manage Site sections, with defaults; `announcement.active` resolved against its schedule |
| GET | `/homepage` | `{ banners, sections[] }`; sections already contain their `products` or `categories` |
| GET | `/banners?placement=hero` · `/popups` | Active and in schedule only |
| GET | `/pages` · `/pages/:slug` | Published only |
| GET | `/categories` · `/categories/:path` | Tree of enabled categories; one category by path (`shoes/sneakers`) with children |
| GET | `/products` | `category` (path), `sub`, `cats`, `sizes`, `colors` (comma lists), `minPrice`, `maxPrice`, `sale=1`, `inStock=1`, `flag=new\|bestseller\|trending\|featured`, `q`, `sort=featured\|new\|low\|high\|off\|bestselling`, `page`, `limit` (≤60), `facets=0` to skip. Returns `data`, `meta`, `facets` {subcategories, categories, sizes, colors, price}, `category` |
| GET | `/products/:slug` · `/products/:id/related` · `/products/by-ids?ids=` · `/products/legacy/:legacyId` | Variants show `inStock` and `stockLeft` (only when at or below the low-stock threshold), never exact stock |
| GET | `/seo/sitemap.xml` · `/seo/robots.txt` | Serve at the storefront's `/sitemap.xml` and `/robots.txt` via a web-server proxy |
| POST | `/seo/404 { path }` | Records a storefront not-found path and returns any configured redirect |
| POST | `/contact` · `/newsletter` | Stored for the admin |

### Auth & account

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` · `/auth/login` · `/auth/refresh` · `/auth/logout` · GET `/auth/me` | Sign-in merges the guest bag into the account |
| POST | `/auth/forgot-password` `{ email }` | Same reply whether or not the email exists; link valid 1 h, single use |
| POST | `/auth/reset-password` `{ token, password }` | Signs out every device |
| PATCH | `/account/profile` `{ name?, phone? }` | |
| POST | `/account/password` `{ currentPassword, newPassword }` | Signs out other devices |
| POST | `/account/delete` `{ password }` | Removes personal data; orders are kept |
| GET/POST/PATCH/DELETE | `/account/addresses[/:id]` | Up to 10; one default |
| GET/POST/DELETE | `/account/wishlist[/:productId]` · POST `/account/wishlist/merge` `{ productIds }` | |

### Cart, checkout, orders, payments

| Method | Path | Notes |
|---|---|---|
| GET | `/cart` | Priced from the database: `lines[]` (with `available` / `issue` / `maxQty`), `coupon`, `totals.cod`, `totals.razorpay`, `commerce` |
| POST | `/cart/items` `{ productId, variantId, qty }` | Guests get an httpOnly `sz_cart` cookie |
| PATCH / DELETE | `/cart/items/:itemId` | |
| PUT | `/cart/coupon` `{ code \| null }` | |
| POST | `/orders` | `{ contact{name,phone,email?}, shippingAddress \| addressId, saveAddress?, paymentMethod: "cod"\|"razorpay", notes?, idempotencyKey? }` → `{ order, payment }`. `payment` is the Razorpay Checkout payload (`keyId`, `razorpayOrderId`, `amount` in paise, `prefill`) |
| GET | `/orders` (signed in) · `/orders/:orderNumber` | Own orders only; guests can see orders placed from the same browser. The detail includes `payment` again so a pending payment can be retried |
| POST | `/orders/:orderNumber/cancel` | Customer: placed/confirmed only |
| POST | `/orders/track` `{ orderNumber, phone }` | Status-only view, for guests |
| POST | `/payments/razorpay/verify` | `{ orderNumber, razorpayOrderId, razorpayPaymentId, razorpaySignature }` from Checkout's success handler |
| POST | `/payments/webhook` | Razorpay → server only. Handles `payment.captured`, `order.paid`, `payment.failed` (with error source/step/reason) and `refund.*` |
| GET | `/orders/:orderNumber/returns` | Own orders: `{ eligibility { eligible, reason, returnBy, items[{ variant, returnable }] }, returns[] }` |
| POST | `/orders/:orderNumber/returns` | `{ items[{ variantId, qty }], reason, comments?, evidence?[{ publicId }] }`. Reasons: `damaged`, `wrong_item`, `defective`, `size_fit`, `not_as_described`, `missing_items`, `changed_mind`, `other` (needs comments) |
| POST | `/returns/uploads` | Multipart `file`, into `shoponzy/returns/return-evidence`; only for customers with a delivered order (max 5 MB, rate limited) |
| POST | `/returns/:returnNumber/cancel` | Customer: while `requested` |

### Admin (`/admin/*`, admin session required)

| Area | Endpoints |
|---|---|
| Auth | `POST /admin/auth/login`, `/refresh`, `/logout`, `GET /admin/auth/me` |
| Dashboard | `GET /dashboard?days=7\|30\|90\|365`: sales, orders, AOV, customers (with % change vs. previous period), products, pending / awaiting payment / needs attention, out-of-stock and low-stock variants, recent orders, daily sales trend (IST), best sellers |
| Categories | `GET /categories?level=&parent=&status=&q=` (with `pathNames`, `productCount`), `GET /categories/tree`, `POST`, `PATCH /:id` (incl. moving via `parent`), `DELETE /:id` |
| Products | `GET /products?q=&category=&status=&stock=out\|low\|in&flag=&sort=` (+ status summary), `GET /:id`, `POST` (either `variants[]`, or `price`/`mrp`/`stock` for a simple product), `PATCH /:id`, `DELETE /:id` (archives if ordered), `POST /:id/stock { variantId, delta \| set, reason, note, expectedStock? }`, `PATCH /:id/low-stock-threshold { lowStockThreshold \| null }`, `POST /products/bulk { ids, action }`, `GET /products/export.csv` |
| Inventory | `GET /inventory?q=&category=&stockStatus=in\|low\|out\|inactive&sort=stock_low\|stock_high\|name\|updated` (one row per variant, with reserved qty and last movement), `GET /inventory/summary`, `GET\|PUT /inventory/settings { lowStockThreshold }`, `GET /inventory/movements?q=&product=&reason=&manual=1&from=&to=`, `GET /inventory/movements/export.csv` (same filters) |
| Orders | `GET /orders?q=&status=&paymentStatus=&paymentMethod=&attention=1&from=&to=&customer=` (+ counts per status), `GET /:id` (+ payments, allowed transitions), `PATCH /:id/status { status, note?, fulfilment?, restock? }`, `PATCH /:id/fulfilment`, `POST /:id/cancel`, `POST /:id/refund { amount?, reason?, manualReference? }`, `GET /:id/invoice` (printable HTML) |
| Transactions | `GET /transactions?status=success\|failed\|pending\|refunded\|partially_refunded&method=upi\|card\|netbanking\|wallet\|emi\|paylater\|cod&q=&from=&to=&sort=` (+ `meta.summary`), `GET /transactions/summary`, `GET /transactions/:id`, `GET /transactions/export.csv` (same filters), `POST /transactions/:id/refunds/:refundId/sync`, `GET /refunds?status=pending\|processed\|failed&q=&from=&to=` |
| Returns | `GET /returns?q=&status=&refundStatus=&view=open\|approved\|refunds&from=&to=`, `GET /returns/summary`, `GET /returns/items` (returned products), `GET /returns/:id`, `POST /returns/:id/approve { note? }`, `/reject { reason, note? }`, `/status { status: pickup_scheduled\|in_transit\|received\|completed\|cancelled, note?, pickup? }`, `/inspect { items[{ index, condition, restockQty }], notes? }`, `/refund { amount?, manualReference?, note? }` |
| Customers | `GET /users?q=&status=&sort=`, `GET /users/:id` (orders, spend, addresses, wishlist), `PATCH /users/:id/status { status }` (disabling signs them out), `GET /wishlists` (most-saved products) |
| Coupons | CRUD `/coupons` (`percent` ≤ 90 or `fixed`, min subtotal, max discount, dates, total/per-customer limits) |
| Manage Site | `GET /site-settings`, `PATCH /site-settings/:section`, `POST /site-settings/:section/reset`. SEO settings include search metadata, webmaster verification IDs, robots.txt directives, robots meta rules, and an optional uploaded sitemap |
| SEO tools | `POST /seo/sitemap/generate`, `POST /seo/sitemap/upload` (multipart field `file`), `GET /seo/404-logs?q=&page=&limit=`, `PATCH /seo/404-logs/:id { redirectTo }`, `DELETE /seo/404-logs/:id` |
| Content | CRUD `/banners` (desktop + mobile image, or gradient + illustration, placement, order, schedule), `/homepage-sections` (+ `PUT /homepage-sections/order { ids }`), `/popups`, `/pages` |
| Uploads | `POST /uploads` (multipart: `file`, `kind`) → `{ url, publicId, … }`, then pass that object as the image field. `DELETE /uploads/:publicId` discards an unused upload. Kinds and Cloudinary folders (all under `shoponzy/`): `product` → products/product-images, `productGallery` → products/product-gallery, `productVariant` → products/product-variants, `category` → categories/category-images, `categoryBanner` → categories/category-banners, `banner` → banners/desktop, `bannerMobile` → banners/mobile, `logo` → branding/logos, `favicon` → branding/favicons, `popup` → popups, `seo` → seo, `maintenance` → site/maintenance, `site` → site/general, `returnEvidence` → returns/return-evidence. Assets uploaded before this layout keep their original public ids |
| Other | `GET/PATCH /contact-messages`, `GET /newsletter`, `GET /newsletter/export.csv`, `GET /audit-logs?action=` |

## Background jobs

Started by `server.js` when `JOBS_ENABLED=true` (enable on one instance only):

- **Every minute:** cancel online-payment orders whose reservation expired and return their stock. Razorpay is checked first, so a payment whose webhook is late is honoured.
- **Hourly** (when Cloudinary is configured): delete uploads older than 24 h that nothing references.

## Structure

```
server.js                 HTTP server, background jobs, graceful shutdown
src/app.js                logging → helmet → CORS → JSON (100 KB; raw body kept for webhooks) → cookies → rate limit → CSRF → routes → 404 → errors
src/config/               env (validated), db
src/models/               User, Session, AuditLog, Category, Product, commerce.js (Cart, Coupon, Order, Payment, InventoryMovement, WebhookEvent, Counter, PasswordReset, Upload), site.js (SiteSetting, Banner, HomepageSection, Popup, Page, ContactMessage, NewsletterSubscriber)
src/services/             auth, token, account, catalog, category, product, cart, pricing, order, razorpay, upload (Cloudinary), email, settings, homepage, dashboard
src/middleware/           auth, csrf, cartOwner, validate, rateLimits, errorHandler
src/validators/           zod schemas per area
src/controllers/, routes/ storeRoutes (public/customer), adminRoutes, authRoutes
src/jobs.js
scripts/                  create-admin.js, seed.js
tests/                    vitest + supertest + in-memory MongoDB replica set; Cloudinary/Razorpay/SMTP mocked
```
