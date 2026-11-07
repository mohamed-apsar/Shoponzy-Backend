import "dotenv/config";
import { z } from "zod";

const bool = (fallback) => z.enum(["true", "false"]).default(String(fallback)).transform((v) => v === "true");
const isTest = process.env.NODE_ENV === "test";
const isVercel = process.env.VERCEL === "1";
const secureCookies = process.env.NODE_ENV === "production" || isVercel;

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default(isVercel ? "production" : "development")
    .transform((v) => isVercel ? "production" : v),
  PORT: z.coerce.number().int().positive().default(5000),
  MONGODB_URI: isTest ? z.string().optional() : z.string().min(1, "MONGODB_URI is required"),

  CLIENT_URL: z.string().url().default(process.env.NODE_ENV === "production" ? "https://shoponzy-user-site.vercel.app" : "http://localhost:5173"),
  ADMIN_URL: z.string().url().default(process.env.NODE_ENV === "production" ? "https://shoponzy-admin.vercel.app" : "http://127.0.0.1:5176"),
  // Public URL of this API including /api/v1 (used in email unsubscribe links). Defaults to the request host.
  PUBLIC_API_URL: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  // Extra comma-separated origins allowed by CORS (e.g. a staging domain).
  CORS_EXTRA_ORIGINS: z.string().default(""),

  JWT_SECRET: isTest ? z.string().default("test-secret-test-secret-test-secret-0000") : z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(isTest ? 4 : 12),

  COOKIE_SECURE: z.enum(["true", "false"]).default(String(secureCookies)).transform((v) => isVercel || v === "true"),
  COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).default(secureCookies ? "none" : "lax")
    .transform((v) => isVercel ? "none" : v),
  COOKIE_DOMAIN: z.string().optional(),
  // Number of reverse proxies in front of the API (for correct client IPs in rate limiting).
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  // Disable to run tests that are not about rate limiting.
  RATE_LIMIT_ENABLED: bool(true),

  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // Any SMTP provider (Gmail, Brevo, SES, Zoho…). Without SMTP_HOST, emails are not sent and
  // password reset reports EMAIL_NOT_CONFIGURED.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default("Shoponzy <no-reply@shoponzy.in>"),

  // Minutes stock stays reserved for an unpaid online-payment order before it is released.
  ORDER_RESERVATION_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  LOW_STOCK_THRESHOLD: z.coerce.number().int().min(0).default(5),
  // Background jobs (reservation expiry, orphaned upload cleanup). Off in tests.
  JOBS_ENABLED: bool(!isTest),
}).superRefine((v, ctx) => {
  if (v.COOKIE_SAMESITE === "none" && !v.COOKIE_SECURE) {
    ctx.addIssue({ code: "custom", path: ["COOKIE_SECURE"], message: "COOKIE_SAMESITE=none requires COOKIE_SECURE=true" });
  }
  if (v.NODE_ENV === "production" && !v.COOKIE_SECURE) {
    ctx.addIssue({ code: "custom", path: ["COOKIE_SECURE"], message: "COOKIE_SECURE must be true in production" });
  }
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  // Fail fast: never start with a missing or weak secret.
  throw new Error(`Invalid environment configuration:\n${lines}`);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
export const cloudinaryConfigured = Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
export const razorpayConfigured = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
export const smtpConfigured = Boolean(env.SMTP_HOST);
export const allowedOrigins = [
  env.CLIENT_URL,
  env.ADMIN_URL,
  "https://shoponzy-user-site.vercel.app",
  "https://shoponzy-admin.vercel.app",
  ...env.CORS_EXTRA_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
]
  .filter((origin, index, origins) => origins.indexOf(origin) === index)
  .map((u) => new URL(u).origin);
