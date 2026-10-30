/* Creates (or promotes) an administrator. Requires shell access to the server and its .env;
   there is deliberately no HTTP endpoint for this.

   npm run create-admin -- --email owner@shoponzy.in --name "Store Owner"
   npm run create-admin -- --email someone@example.com --promote     (existing account → admin)

   The password is prompted for (hidden). For automation, set ADMIN_PASSWORD instead. */
import { parseArgs } from "node:util";
import readline from "node:readline";
import { env } from "../src/config/env.js";
import { connectDb, disconnectDb } from "../src/config/db.js";
import { User } from "../src/models/User.js";
import { audit } from "../src/models/AuditLog.js";
import { hashPassword, revokeAllSessions } from "../src/services/authService.js";
import { email as emailSchema, name as nameSchema } from "../src/validators/common.js";

const MIN_ADMIN_PASSWORD = 12;

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = false;
    rl._writeToOutput = (s) => { if (!rl.stdoutMuted) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write("\n"); resolve(answer); });
    rl.stdoutMuted = true;
  });
}

async function main() {
  const { values } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" }, promote: { type: "boolean", default: false } } });
  const email = emailSchema.parse(values.email ?? "");

  await connectDb(env.MONGODB_URI);
  try {
    const existing = await User.findOne({ email });
    if (values.promote) {
      if (!existing) throw new Error(`No account with email ${email}.`);
      if (existing.role === "admin") return console.log(`${email} is already an admin.`);
      existing.role = "admin";
      await existing.save();
      // Force a fresh sign-in so no customer-audience session carries over.
      await revokeAllSessions(existing._id, "promoted_to_admin");
      await audit("admin.promoted", { entity: "User", entityId: existing._id, meta: { email, via: "cli" } });
      return console.log(`Promoted ${email} to admin.`);
    }
    if (existing) throw new Error(`An account with ${email} already exists. Use --promote to make it an admin.`);

    const name = nameSchema.parse(values.name ?? "");
    let password = process.env.ADMIN_PASSWORD;
    if (!password) {
      password = await askHidden("Password: ");
      if (password !== (await askHidden("Repeat password: "))) throw new Error("Passwords do not match.");
    }
    if (password.length < MIN_ADMIN_PASSWORD || password.length > 128) throw new Error(`Admin passwords must be ${MIN_ADMIN_PASSWORD}–128 characters.`);

    const user = await User.create({ name, email, passwordHash: await hashPassword(password), role: "admin" });
    await audit("admin.created", { entity: "User", entityId: user._id, meta: { email, via: "cli" } });
    console.log(`Created admin ${email}. Sign in at ${env.ADMIN_URL}`);
  } finally {
    await disconnectDb();
  }
}

main().catch((err) => {
  console.error(`create-admin failed: ${err.issues?.map((i) => i.message).join(", ") || err.message}`);
  process.exit(1);
});
