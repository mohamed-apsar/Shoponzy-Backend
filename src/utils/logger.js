import pino from "pino";

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === "test" ? "silent" : "info");

// Never log credentials, tokens or cookies.
export const logger = pino({
  level,
  redact: { paths: ["req.headers.cookie", "req.headers.authorization", "req.headers['x-csrf-token']", 'res.headers["set-cookie"]', "*.password", "*.token"], censor: "[redacted]" },
});
