import mongoose from "mongoose";

/* Runs fn(session) inside a MongoDB transaction (retried by the driver on transient write conflicts). */
export async function inTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); });
    return result;
  } finally {
    await session.endSession();
  }
}
