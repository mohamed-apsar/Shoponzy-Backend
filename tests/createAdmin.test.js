import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import request from "supertest";
import { API, app, browser, createUser, useDb } from "./helpers.js";
import { User } from "../src/models/User.js";
import { AuditLog } from "../src/models/AuditLog.js";

useDb();
const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/create-admin.js", import.meta.url));

/* Runs the real CLI against this test file's database. */
function createAdmin(args, password) {
  const { host, port, name } = mongoose.connection;
  const uri = `mongodb://${host}:${port}/${name}?directConnection=true`;
  return run(process.execPath, [script, ...args], {
    env: { ...process.env, NODE_ENV: "test", MONGODB_URI: uri, LOG_LEVEL: "silent", ...(password ? { ADMIN_PASSWORD: password } : {}) },
  });
}

describe("npm run create-admin", () => {
  it("creates an admin who can then sign in to the admin panel", async () => {
    const { stdout } = await createAdmin(["--email", "Owner@Shoponzy.in", "--name", "Store Owner"], "a-long-admin-passphrase");
    expect(stdout).toContain("Created admin owner@shoponzy.in");
    const admin = await User.findOne({ email: "owner@shoponzy.in" });
    expect(admin.role).toBe("admin");
    expect(await AuditLog.countDocuments({ action: "admin.created" })).toBe(1);

    const b = await browser();
    await b.post("/admin/auth/login", { email: "owner@shoponzy.in", password: "a-long-admin-passphrase" }).expect(200);
  });

  it("refuses short admin passwords", async () => {
    await expect(createAdmin(["--email", "owner@shoponzy.in", "--name", "Store Owner"], "short")).rejects.toThrow(/12–128 characters/);
    expect(await User.countDocuments()).toBe(0);
  });

  it("won't overwrite an existing account, but can promote it explicitly", async () => {
    const user = await createUser({ email: "existing@example.com" });
    await expect(createAdmin(["--email", "existing@example.com", "--name", "X Y"], "a-long-admin-passphrase")).rejects.toThrow(/already exists/);
    await createAdmin(["--email", "existing@example.com", "--promote"]);
    expect((await User.findById(user._id)).role).toBe("admin");
  });

  it("there is no HTTP route that creates admins", async () => {
    await request(app).post(`${API}/admin/users`).expect(403); // CSRF first…
    const b = await browser();
    await b.post("/admin/users", { email: "x@example.com", role: "admin" }).expect(401); // …then auth; no such handler exists.
  });
});
