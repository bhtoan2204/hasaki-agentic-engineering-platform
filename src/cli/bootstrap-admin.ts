/**
 * One-time first admin. There is no default password and no HTTP bootstrap route.
 *
 *   AUTH_SECRET=... DATABASE_URL=... npm run admin:bootstrap -- --username alice
 *   ADMIN_PASSWORD is read from the environment (not argv). The process prompts when stdin is a TTY.
 *
 *   --claim-legacy   assign existing ownerless private rows to this admin, in the same transaction
 *                    as creating the user when this is the first user. Shared templates and seeded
 *                    knowledge stay shared. Run again with --claim-legacy --username alice later
 *                    only to claim; it will not create a second admin.
 */
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin, stdout } from "node:process";
import { migrate } from "../db/migrate.ts";
import { claimLegacy } from "../auth/legacy.ts";
import { assertUsername, createUser, userByUsername } from "../auth/users.ts";
import { one, pool, withTx } from "../db/pool.ts";

function arg(name: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function password(): Promise<string> {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (!stdin.isTTY) {
    console.error("Set ADMIN_PASSWORD in the environment, or run this from a terminal so it can prompt.");
    process.exit(1);
  }
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const rl = createInterface({ input: stdin, output: muted, terminal: true });
  const ask = async (label: string) => {
    stdout.write(label);
    const answer = await rl.question("");
    stdout.write("\n");
    return answer;
  };
  let a: string, b: string;
  try {
    a = await ask("Password (10–200 characters, hidden): ");
    b = await ask("Repeat password: ");
  } finally { rl.close(); }
  if (a !== b) {
    console.error("Passwords did not match.");
    process.exit(1);
  }
  return a;
}

const username = arg("--username");
const claim = process.argv.includes("--claim-legacy");
if (!username) {
  console.error("Usage: npm run admin:bootstrap -- --username <name> [--claim-legacy]");
  process.exit(1);
}

if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 16) {
  console.error("AUTH_SECRET must be set (at least 16 characters). Refusing to bootstrap.");
  process.exit(1);
}

try {
  const name = assertUsername(username);
  await migrate(); // Always before querying users, including an empty database.
  const existing = await userByUsername(name);
  const count = await one<{ n: number }>(pool, "SELECT count(*)::int AS n FROM users");
  if (!existing && count!.n > 0) throw new Error("A user already exists. This command only creates the first admin.");
  if (existing && (existing.role !== "admin" || !existing.active)) throw new Error("The existing user must be an active admin; no account changes were made.");
  const pw = existing ? undefined : await password();
  const result = await withTx(async (c) => {
    await c.query("LOCK TABLE users IN EXCLUSIVE MODE");
    let user = await one<{ id: number; role: string; active: boolean }>(c, "SELECT id, role, active FROM users WHERE username = $1", [name]);
    let created = false;
    if (!user) {
      const n = await one<{ n: number }>(c, "SELECT count(*)::int AS n FROM users");
      if (n!.n) throw new Error("A user already exists. This command only creates the first admin.");
      user = await createUser({ username: name, password: pw!, role: "admin" }, c);
      created = true;
    }
    if (user.role !== "admin" || !user.active) throw new Error("Claim target must be an active admin.");
    return { created, claimed: claim ? await claimLegacy(user.id, c) : null };
  });
  console.log(result.created ? `Created admin ${name}.` : `Admin ${name} already exists; password and role unchanged.`);
  if (result.claimed) console.log(`Claimed legacy private rows: ${JSON.stringify(result.claimed)}. Shared templates and knowledge unchanged.`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
