import { env } from "./src/config/env.js";
import { connectDb, disconnectDb } from "./src/config/db.js";
import { createApp } from "./src/app.js";
import { logger } from "./src/utils/logger.js";
import { startJobs } from "./src/jobs.js";

await connectDb(env.MONGODB_URI);
const server = createApp().listen(env.PORT, () => logger.info({ port: env.PORT, env: env.NODE_ENV }, "Shoponzy API listening"));
const jobs = startJobs();

// Finish in-flight requests, then close the DB connection.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    logger.info({ signal }, "Shutting down");
    jobs.forEach(clearInterval);
    server.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
