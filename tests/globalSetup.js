import { MongoMemoryReplSet } from "mongodb-memory-server";

/* One in-memory replica set for the whole run (replica set = transactions available, like Atlas). */
let replSet;

export async function setup({ provide }) {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  provide("mongoUri", replSet.getUri());
}

export async function teardown() {
  await replSet?.stop();
}
