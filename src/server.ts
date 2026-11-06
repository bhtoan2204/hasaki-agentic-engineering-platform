import { createServer } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
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

// The Claude Agent SDK (and detect-libc) call process.report.getReport() to tell glibc from musl. By default a report
// resolves every open socket's peer with a SYNCHRONOUS reverse-DNS lookup on the main thread; over VPN each lookup
// times out (5 s), so with the DB pool and SSE sockets open the whole server froze for minutes at every agent start.
(process.report as NodeJS.ProcessReport & { excludeNetwork: boolean }).excludeNetwork = true; // Node ≥ 22.13; older @types lack it

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

// Bind the port BEFORE starting workers: a second copy of the server (port already taken) must exit without having
// claimed any job — otherwise it claims work, dies, and the job later fails with "worker lease expired".
const server = createServer(handle);
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  // One shared installation. HOST=0.0.0.0 exposes it on the central machine; the default stays loopback.
  server.listen(config.port, process.env.HOST ?? "127.0.0.1", () => resolve());
}).catch((e: NodeJS.ErrnoException) => {
  console.error(e.code === "EADDRINUSE" ? `port ${config.port} is already in use: another platform server is running. Not starting.` : `cannot listen: ${e.message}`);
  process.exit(1);
});
console.log(`workflow platform on ${config.publicUrl} (instance ${config.instanceId})`);

// Durable scheduler: in-flight work resumes from PostgreSQL (expired leases are reaped and retried).
const scheduler = startScheduler();
startPolling();
startProdErrorSchedule();

// Graceful shutdown: running steps are interrupted and handed back to the queue (no retry used), so restarting the
// server never fails a step. A second Ctrl+C exits immediately.
let shuttingDown = false;
async function shutdown(reason: string, code: number) {
  if (shuttingDown) {
    console.log("forced exit");
    process.exit(code || 1);
  }
  shuttingDown = true;
  console.log(`${reason}: stopping workers; running steps are handed back to the queue (Ctrl+C again to force)`);
  server.close();
  childGroups.killAll(); // detached command process groups (go test, ...) would otherwise outlive the server
  // Releasing needs a few database round trips per step (slow over VPN): allow time, but never hang forever.
  setTimeout(() => process.exit(code), 30_000).unref();
  try {
    await scheduler.drain(reason);
  } catch (e) {
    console.error("shutdown:", (e as Error).message);
  }
  process.exit(code);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void shutdown(sig, 0));

// A stray rejected promise (typically a database timeout in fire-and-forget code) must not kill the server and
// every step running in it. Log it with a timestamp so it can be traced.
process.on("unhandledRejection", (reason) => {
  console.error(`[${new Date().toISOString()}] unhandled rejection (server kept running):`, reason instanceof Error ? reason.stack : reason);
});
// A thrown exception leaves the process in an unknown state: log it, hand running steps back, then exit.
process.on("uncaughtException", (e) => {
  console.error(`[${new Date().toISOString()}] uncaught exception:`, e.stack ?? e);
  void shutdown("uncaught exception", 1);
});

// Event-loop stalls freeze everything at once (heartbeats, agent sessions, HTTP): report them when they happen.
const loopDelay = monitorEventLoopDelay({ resolution: 50 });
loopDelay.enable();
setInterval(() => {
  const maxMs = loopDelay.max / 1e6;
  if (maxMs > 2000) console.warn(`[${new Date().toISOString()}] event loop blocked for up to ${(maxMs / 1000).toFixed(1)}s in the last minute`);
  loopDelay.reset();
}, 60_000).unref();
