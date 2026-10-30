import { z } from "zod";

export const email = z.string().trim().toLowerCase().email("Enter a valid email address.").max(254);
// Indian mobile: accepts "+91 98765 43210", "09876543210" etc.; stored as 10 digits.
export const phone = z.string().trim()
  .transform((v) => v.replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, ""))
  .refine((v) => /^[6-9]\d{9}$/.test(v), "Enter a valid 10-digit mobile number.");
export const password = z.string().min(8, "Use at least 8 characters.").max(128, "Use at most 128 characters.");
export const name = z.string().trim().min(2, "Enter your name.").max(100);
export const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id.");
export const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
