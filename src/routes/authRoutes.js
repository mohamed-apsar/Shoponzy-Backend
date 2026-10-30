import { Router } from "express";
import * as auth from "../controllers/authController.js";
import { authenticate, optionalAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { loginAccountLimiter, loginIpLimiter, refreshLimiter, registerLimiter } from "../middleware/rateLimits.js";
import { loginSchema, registerSchema } from "../validators/authValidators.js";

/* Same endpoints for both audiences, mounted at /auth (storefront) and /admin/auth (admin panel). */
export function authRouter(audience) {
  const r = Router();
  if (audience === "customer") r.post("/register", registerLimiter, validate({ body: registerSchema }), auth.register);
  r.post("/login", loginIpLimiter, loginAccountLimiter, validate({ body: loginSchema }), auth.login(audience));
  r.post("/refresh", refreshLimiter, auth.refresh(audience));
  r.post("/logout", optionalAuth(audience), auth.logout(audience));
  r.get("/me", authenticate(audience), auth.me);
  return r;
}
