import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import { allowedOrigins, env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { apiLimiter } from "./middleware/rateLimits.js";
import { csrfProtection } from "./middleware/csrf.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { ok } from "./utils/respond.js";
import routes from "./routes/index.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/api/v1/health" } }));
  // JSON-only API: no HTML is served, so the CSP can be maximally strict.
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token"],
    maxAge: 600,
  }));
  // The raw bytes are kept for webhook signature verification (the signature covers the exact body).
  // One-click unsubscribe (RFC 8058) posts a small form body.
  app.use("/api/v1/newsletter/unsubscribe", express.urlencoded({ extended: false, limit: "2kb" }));
  app.use(express.json({ limit: "100kb", verify: (req, _res, buf) => { if (req.url.startsWith("/api/v1/payments/webhook")) req.rawBody = buf; } }));
  app.use(cookieParser());

  app.get("/", (_req, res) => ok(res, {
    name: "Shoponzy API",
    status: "ok",
    health: "/api/v1/health",
    api: "/api/v1",
  }));
  app.use("/api/v1", apiLimiter, csrfProtection({ exempt: ["/payments/webhook", "/newsletter/unsubscribe"] }), routes);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
