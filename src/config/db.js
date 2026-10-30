import mongoose from "mongoose";
import { logger } from "../utils/logger.js";

// Reject query keys that aren't in the schema. NoSQL-operator injection is prevented at the edge:
// every request is parsed by a strict zod schema, so user input reaches queries only as plain
// strings/numbers/ids. (Mongoose's global sanitizeFilter is not used: it also neutralises the
// server's own $-operators, e.g. { createdAt: { $lt: … } }.)
mongoose.set("strictQuery", true);

export async function connectDb(uri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  logger.info({ host: mongoose.connection.host, db: mongoose.connection.name }, "MongoDB connected");
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

export const dbState = () => ["disconnected", "connected", "connecting", "disconnecting"][mongoose.connection.readyState] || "unknown";
