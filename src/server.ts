import { createServer } from "node:http";
import { config } from "./config.ts";
import { handle } from "./http/app.ts";
import { migrate } from "./db/migrate.ts";
import { startPolling } from "./work.ts";
import { loadToken } from "./hasakiAuth.ts";
import { loadArgoToken } from "./integrations/argocd.ts";
import { loadSplunkCookie } from "./integrations/splunk.ts";
import { loadKafkaCookie } from "./integrations/kafka.ts";
import { loadAccountSettings } from "./integrations/accounts.ts";
import { loadVaultToken } from "./integrations/vault.ts";
import { startProdErrorSchedule } from "./prodErrors/scan.ts";
import { seedTemplates } from "./workflow/definitions.ts";
import { registerDefaultExecutors } from "./workflow/executors/index.ts";
import { startScheduler } from "./workflow/scheduler.ts";
import { syncRepositoriesFromConfig } from "./repos/service.ts";
import { seedKnowledge } from "./knowledge/service.ts";
import { startEventStream } from "./api/stream.ts";
import { childGroups } from "./workflow/local.ts";

if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 16) {
  console.error("AUTH_SECRET must be set (at least 16 characters). Refusing to start.");
  process.exit(1);
}

const applied = await migrate();
if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);
await seedTemplates();
await syncRepositoriesFromConfig();
await seedKnowledge();
await loadAccountSettings();
await loadToken();
await loadArgoToken();
await loadSplunkCookie();
await loadKafkaCookie();
await loadVaultToken();
registerDefaultExecutors();
await startEventStream();
// Durable scheduler: in-flight work resumes from PostgreSQL (expired leases are reaped and retried).
const scheduler = startScheduler();
startPolling();
startProdErrorSchedule();

// One shared installation. HOST=0.0.0.0 exposes it on the central machine; the default stays loopback.
const server = createServer(handle).listen(config.port, process.env.HOST ?? "127.0.0.1", () => console.log(`workflow platform on ${config.publicUrl}`));

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, async () => {
    console.log(`${sig}: stopping workers (in-flight attempts finish or are reaped after their lease)`);
    server.close();
    childGroups.killAll(); // detached command process groups (go test, ...) would otherwise outlive the server
    setTimeout(() => process.exit(0), 3000).unref();
    await scheduler.stop();
    process.exit(0);
  });
