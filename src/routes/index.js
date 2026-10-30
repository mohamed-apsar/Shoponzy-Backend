import { Router } from "express";
import { issueCsrfToken } from "../middleware/csrf.js";
import { dbState } from "../config/db.js";
import { ok } from "../utils/respond.js";
import { authRouter } from "./authRoutes.js";
import adminRoutes from "./adminRoutes.js";
import storeRoutes from "./storeRoutes.js";

const router = Router();

router.get("/health", (_req, res) => ok(res, { status: "ok", db: dbState(), time: new Date().toISOString() }));
router.get("/csrf", issueCsrfToken);
router.use("/auth", authRouter("customer"));
router.use("/admin", adminRoutes);
router.use(storeRoutes);

export default router;
