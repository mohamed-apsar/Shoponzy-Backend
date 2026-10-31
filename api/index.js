import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { connectDb } from "../src/config/db.js";
import { env } from "../src/config/env.js";
import { logger } from "../src/utils/logger.js";

const app = createApp();
let connectionPromise;

async function ensureDbConnection() {
  if (mongoose.connection.readyState === 1) return;
  if (mongoose.connection.readyState !== 2 || !connectionPromise) {
    connectionPromise = connectDb(env.MONGODB_URI).finally(() => {
      connectionPromise = undefined;
    });
  }
  await connectionPromise;
}

export default async function handler(req, res) {
  try {
    await ensureDbConnection();
  } catch (error) {
    logger.error({ err: error }, "MongoDB connection failed");
    return res.status(503).json({
      success: false,
      error: { code: "DATABASE_UNAVAILABLE", message: "Service temporarily unavailable" },
    });
  }

  return app(req, res);
}
