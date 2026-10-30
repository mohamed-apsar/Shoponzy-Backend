import { z } from "zod";
import { email, name, password, phone } from "./common.js";

export const registerSchema = z.object({
  name,
  email,
  phone: phone.optional(),
  password,
}).strict();

export const loginSchema = z.object({
  email,
  password: z.string().min(1, "Enter your password.").max(128),
}).strict();
