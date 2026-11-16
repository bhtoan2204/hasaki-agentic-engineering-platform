import { migrateLegacyRepositories } from "../repos/legacy.ts";
import { pool } from "../db/pool.ts";
import { migrate } from "../db/migrate.ts";
if (process.argv.slice(2).some((a) => a !== "--apply")) throw new Error("Usage: npm run repositories:migrate -- [--apply]");
try {
  await migrate();
  console.log(JSON.stringify(await migrateLegacyRepositories(process.argv.includes("--apply")), null, 2));
} finally { await pool.end(); }
