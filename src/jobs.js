import { env, cloudinaryConfigured } from "./config/env.js";
import { expireReservations } from "./services/orderService.js";
import { cleanupOrphanUploads } from "./services/uploadService.js";
import { logger } from "./utils/logger.js";

/* In-process timers: fine for a single API instance. With several instances, run them on one
   (JOBS_ENABLED=true) and disable on the others. Each job skips a tick if the previous run is still going. */
function every(ms, name, fn) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const n = await fn();
      if (n) logger.info({ job: name, count: n }, "Job finished");
    } catch (err) {
      logger.error({ job: name, err: err?.message }, "Job failed");
    } finally {
      running = false;
    }
  }, ms);
  timer.unref();
  return timer;
}

export function startJobs() {
  if (!env.JOBS_ENABLED) return [];
  const timers = [every(60_000, "expire-reservations", () => expireReservations())];
  if (cloudinaryConfigured) timers.push(every(3_600_000, "cleanup-orphan-uploads", () => cleanupOrphanUploads()));
  logger.info({ jobs: timers.length }, "Background jobs started");
  return timers;
}
