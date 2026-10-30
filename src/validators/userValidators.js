import { z } from "zod";
import { pagination } from "./common.js";
import { ROLES, USER_STATUSES } from "../models/User.js";

export const listUsersQuery = z.object({
  ...pagination,
  q: z.string().trim().max(100).optional(),
  role: z.enum(ROLES).default("customer"),
  status: z.enum(USER_STATUSES).optional(),
  sort: z.enum(["newest", "oldest", "name"]).default("newest"),
});
