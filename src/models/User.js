import mongoose from "mongoose";
import { toJSONPlugin } from "./plugins.js";

export const ROLES = ["customer", "admin"];
export const USER_STATUSES = ["active", "disabled"];

const addressSchema = new mongoose.Schema({
  label: { type: String, trim: true, maxlength: 40, default: "Home" },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  phone: { type: String, required: true, trim: true, match: /^[6-9]\d{9}$/ },
  line1: { type: String, required: true, trim: true, maxlength: 200 },
  line2: { type: String, trim: true, maxlength: 200 },
  city: { type: String, required: true, trim: true, maxlength: 80 },
  state: { type: String, required: true, trim: true, maxlength: 80 },
  pincode: { type: String, required: true, match: /^\d{6}$/ },
  isDefault: { type: Boolean, default: false },
}, { timestamps: true });
toJSONPlugin(addressSchema);

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
  phone: { type: String, trim: true, match: /^[6-9]\d{9}$/ },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ROLES, default: "customer", index: true },
  status: { type: String, enum: USER_STATUSES, default: "active", index: true },
  addresses: { type: [addressSchema], default: [], validate: [(a) => a.length <= 10, "You can save up to 10 addresses."] },
  wishlist: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],
  deletedAt: Date,
  lastLoginAt: Date,
}, { timestamps: true });

toJSONPlugin(userSchema, { hidden: ["passwordHash"] });

export const User = mongoose.model("User", userSchema);
