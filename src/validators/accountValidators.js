import { z } from "zod";
import { email, name, objectId, password, phone } from "./common.js";

export const profileSchema = z.object({ name: name.optional(), phone: z.union([phone, z.literal("")]).optional() }).strict();
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }).strict();
export const deleteAccountSchema = z.object({ password: z.string().min(1).max(128) }).strict();
export const forgotPasswordSchema = z.object({ email }).strict();
export const resetPasswordSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Invalid reset link."), password }).strict();
export const wishlistAddSchema = z.object({ productId: objectId }).strict();
export const wishlistMergeSchema = z.object({ productIds: z.array(objectId).max(100) }).strict();
export const createSupportTicketSchema = z.object({
  subject: z.string().trim().min(3, "Enter a short subject.").max(120),
  type: z.enum(["Website problem", "Order issue", "Payment issue", "Delivery issue", "Return / exchange", "Product question", "Other"]),
  priority: z.enum(["low", "medium", "high"]),
  message: z.string().trim().min(10, "Describe the issue in at least 10 characters.").max(3000),
  attachment: z.object({ publicId: z.string().trim().min(1).max(200), filename: z.string().trim().min(1).max(200) }).strict().optional(),
}).strict();
export const userStatusSchema = z.object({ status: z.enum(["active", "disabled"]) }).strict();
