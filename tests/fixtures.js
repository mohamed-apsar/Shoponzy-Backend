import crypto from "node:crypto";
import { PASSWORD, browser, createUser } from "./helpers.js";
import { Category } from "../src/models/Category.js";
import { createCategory } from "../src/services/categoryService.js";
import { createProduct } from "../src/services/productService.js";
import { setCloudinaryClient } from "../src/services/uploadService.js";
import { setRazorpayClient } from "../src/services/razorpayService.js";
import { setMailTransport } from "../src/services/emailService.js";

/* ---------- Signed-in browsers ---------- */
export async function adminBrowser() {
  const admin = await createUser({ email: `admin${crypto.randomBytes(2).toString("hex")}@shoponzy.in`, role: "admin", name: "Store Admin" });
  const b = await browser();
  await b.post("/admin/auth/login", { email: admin.email, password: PASSWORD }).expect(200);
  return Object.assign(b, { user: admin });
}

export async function customerBrowser(overrides = {}) {
  const user = await createUser(overrides);
  const b = await browser();
  await b.post("/auth/login", { email: user.email, password: PASSWORD }).expect(200);
  return Object.assign(b, { user });
}

/* ---------- Catalogue ---------- */
export async function category(name = "Shoes", parent = null, extra = {}) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const existing = await Category.findOne({ slug, parent: parent?._id || null });
  return existing || createCategory({ name, slug, parent: parent?._id, ...extra });
}

/* A sneaker in 2 colours × 3 sizes (6 variants), 5 in stock each by default. */
export async function sneaker(overrides = {}) {
  const shoes = await category("Shoes");
  const sneakers = await category("Sneakers", shoes);
  const stock = overrides.stock ?? 5;
  const colors = [{ name: "White", hex: "#F2F2F2" }, { name: "Black", hex: "#1E1E1E" }];
  const sizes = ["7", "8", "9"];
  return createProduct({
    name: overrides.name || `Everyday Sneaker ${crypto.randomBytes(2).toString("hex")}`, category: String(sneakers._id),
    colors, sizes, variants: colors.flatMap((c) => sizes.map((s) => ({ color: c.name, size: s, price: overrides.price ?? 1000, mrp: overrides.mrp ?? 2000, stock }))),
    isNewArrival: true, ...overrides.extra,
  });
}

/* A one-variant product. */
export async function simpleProduct({ name = "Leather Wallet", price = 500, mrp = 0, stock = 10, categoryName = "Essentials", ...extra } = {}) {
  const cat = await category(categoryName);
  return createProduct({ name, category: String(cat._id), price, mrp, stock, ...extra });
}

export const variantOf = (product, color, size) => product.variants.find((v) => v.color === color && v.size === size);

/* ---------- External services (mocked) ---------- */
export function mockCloudinary() {
  const uploaded = new Map(), destroyed = [];
  let n = 0;
  const client = {
    async upload(buffer, options) {
      if (client.fail) throw Object.assign(new Error("Cloudinary down"), { http_code: 500 });
      const public_id = `${options.folder}/img${++n}`;
      const result = { public_id, secure_url: `https://res.cloudinary.com/demo/image/upload/v1/${public_id}.jpg`, bytes: buffer.length, width: 800, height: 800, format: "jpg" };
      uploaded.set(public_id, result);
      return result;
    },
    async destroy(publicId) { destroyed.push(publicId); return { result: "ok" }; },
    fail: false,
  };
  setCloudinaryClient(client);
  return { client, uploaded, destroyed };
}

export function mockRazorpay(secret = "test_key_secret") {
  const orders = new Map(), payments = new Map(), refunds = [];
  let n = 0;
  const client = {
    keyId: "rzp_test_mock",
    failCreate: false,
    async createOrder(o) {
      if (client.failCreate) throw new Error("gateway timeout");
      const id = `order_${++n}${crypto.randomBytes(3).toString("hex")}`;
      orders.set(id, { id, ...o, status: "created" });
      return orders.get(id);
    },
    async fetchPayment(id) {
      const p = payments.get(id);
      if (!p) throw Object.assign(new Error("not found"), { error: { description: "The id provided does not exist" } });
      return { ...p };
    },
    async capturePayment(id) { const p = payments.get(id); p.status = "captured"; return { ...p }; },
    async fetchOrderPayments(orderId) { return [...payments.values()].filter((p) => p.order_id === orderId); },
    async refund(paymentId, { amount }) {
      if (client.failRefund) throw { error: { description: "Refund amount exceeds" } };
      const r = { id: `rfnd_${++n}`, payment_id: paymentId, amount, status: client.refundStatus || "processed" };
      refunds.push(r);
      return { ...r };
    },
    async fetchRefund(paymentId, refundId) {
      const r = refunds.find((x) => x.id === refundId && x.payment_id === paymentId);
      if (!r) throw Object.assign(new Error("not found"), { error: { description: "The id provided does not exist" } });
      return { ...r };
    },
    /* Simulates the customer paying in Razorpay Checkout. */
    pay(orderId, { amount, status = "captured", method = "upi", extra = { vpa: "shopper@okaxis" } } = {}) {
      const id = `pay_${++n}${crypto.randomBytes(3).toString("hex")}`;
      payments.set(id, { id, order_id: orderId, amount: amount ?? orders.get(orderId).amount, currency: "INR", status, method, ...extra });
      return payments.get(id);
    },
    sign: (orderId, paymentId) => crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex"),
  };
  setRazorpayClient(client);
  return { client, orders, payments, refunds };
}

export function mockMail() {
  const sent = [];
  setMailTransport({ async sendMail(m) { sent.push(m); return { messageId: String(sent.length) }; } });
  return sent;
}
export const disableMail = () => setMailTransport(null);

export const ADDRESS = { name: "Asha Kumar", phone: "9876543210", line1: "12 Test Street, Anna Nagar", city: "Chennai", state: "Tamil Nadu", pincode: "600040" };
export const CONTACT = { name: "Asha Kumar", phone: "9876543210", email: "asha@example.com" };
export const key = () => crypto.randomBytes(12).toString("hex");
