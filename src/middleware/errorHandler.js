import mongoose from "mongoose";
import { ZodError } from "zod";
import { isProd } from "../config/env.js";
import { AppError } from "../utils/AppError.js";
import { logger } from "../utils/logger.js";

export function notFound(req) {
  throw AppError.notFound(`No route for ${req.method} ${req.path}`);
}

function normalise(err) {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new AppError(400, "VALIDATION_ERROR", "Please check the highlighted fields.", err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  if (err instanceof mongoose.Error.CastError) return new AppError(400, "INVALID_ID", `Invalid ${err.path}.`);
  if (err instanceof mongoose.Error.ValidationError) {
    return new AppError(400, "VALIDATION_ERROR", "Please check the highlighted fields.", Object.values(err.errors).map((e) => ({ path: e.path, message: e.message })));
  }
  if (err?.code === 11000) return new AppError(409, "DUPLICATE", "A record with these details already exists.");
  if (err?.type === "entity.parse.failed") return new AppError(400, "INVALID_JSON", "Request body is not valid JSON.");
  if (err?.type === "entity.too.large") return new AppError(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
  if (err?.name === "MulterError") {
    return err.code === "LIMIT_FILE_SIZE"
      ? new AppError(413, "FILE_TOO_LARGE", "That image is too large.")
      : new AppError(400, "BAD_UPLOAD", "Send one image in the \"file\" field.");
  }
  return null;
}

/* exposeInternals adds the message/stack of unexpected errors to responses — development only. */
export function makeErrorHandler({ exposeInternals }) {
  // eslint-disable-next-line no-unused-vars
  return function errorHandler(err, req, res, _next) {
    const known = normalise(err);
    if (!known) {
      // Unexpected: log everything server-side, reveal nothing to the client in production.
      (req.log || logger).error({ err }, "Unhandled error");
      return res.status(500).json({
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again.", ...(exposeInternals ? { debug: err?.message, stack: err?.stack } : {}) },
      });
    }
    if (known.status >= 500) (req.log || logger).error({ err }, known.message);
    res.status(known.status).json({ success: false, error: { code: known.code, message: known.message, ...(known.details ? { details: known.details } : {}) } });
  };
}

export const errorHandler = makeErrorHandler({ exposeInternals: !isProd });
