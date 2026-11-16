import { startTelegramTransport } from "./telegram/transport.ts";
import { enqueue as enqueueCodeIndex } from "./codeIntelligence/indexer.ts";
import { repositories } from "./repos/service.ts";
import { background, settleBackground } from "./workflow/background.ts";
import { createServer } from "node:http";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { config } from "./config.ts";
import { startInstanceHeartbeat } from "./instances.ts";
import { validateLocalConfiguration } from "./startupValidation.ts";
import { handle } from "./http/app.ts";
import { migrate } from "./db/migrate.ts";
import { startPolling } from "./work.ts";
import { loadToken } from "./hasakiAuth.ts";
import { loadArgoToken } from "./integrations/argocd.ts";
import { loadSplunkCookie } from "./integrations/splunk.ts";
import { loadKafkaCookie } from "./integrations/kafka.ts";
import { loadAccountSettings } from "./integrations/accounts.ts";
import { loadOperatorSettings } from "./platform/operatorSettings.ts";
import { loadVaultToken } from "./integrations/vault.ts";
import { startProdErrorSchedule } from "./prodErrors/scan.ts";
import { seedTemplates } from "./workflow/definitions.ts";
import { registerDefaultExecutors } from "./workflow/executors/index.ts";
import { startScheduler } from "./workflow/scheduler.ts";
import { startCacheInvalidation } from "./cache/index.ts";
import { syncRepositoriesFromConfig } from "./repos/service.ts";
import { seedKnowledge } from "./knowledge/service.ts";
import { startEventStream, stopEventStream } from "./api/stream.ts";
import { childGroups } from "./workflow/local.ts";

// The Claude Agent SDK (and detect-libc) call process.report.getReport() to tell glibc from musl. By default a report
// resolves every open socket's peer with a SYNCHRONOUS reverse-DNS lookup on the main thread; over VPN each lookup
// times out (5 s), so with the DB pool and SSE sockets open the whole server froze for minutes at every agent start.
(process.report as NodeJS.ProcessReport & { excludeNetwork: boolean }).excludeNetwork = true; // Node ≥ 22.13; older @types lack it

// Node gives each address of a host only 250 ms to connect before trying the next ("happy eyeballs"), and fails the
// whole connection when every attempt is cut short. Without an IPv6 route (WSL) and with a distant server (Telegram:
// ~1 s to connect from here), every outbound fetch to it failed with ETIMEDOUT after ~280 ms — the Telegram receiver
// logged that as "Telegram API error 503". Give each address 2.5 s; a real outage still fails at the caller's timeout.
setDefaultAutoSelectFamilyAttemptTimeout(2500);

if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 16) {
  console.error("AUTH_SECRET must be set (at least 16 characters). Refusing to start.");
  process.exit(1);
}

const applied = await migrate();
if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);
const instanceHeartbeat = await startInstanceHeartbeat({
  waitForPrevious: true,
  onWait: (seconds) =>
    console.log(
      `Waiting ${seconds}s for the previous instance registration to expire. An active installation will remain protected.`,
    ),
});
await seedTemplates();
await syncRepositoriesFromConfig();
for (const warning of await validateLocalConfiguration())
  console.warn(`Startup warning: ${warning}`);
await seedKnowledge();
await loadAccountSettings();
await loadOperatorSettings();
await loadToken();
await loadArgoToken();
await loadSplunkCookie();
await loadKafkaCookie();
await loadVaultToken();
registerDefaultExecutors();
await startEventStream();
// Other processes' writes to cached tables (knowledge, repositories, workflows) arrive here; caches are bypassed while
// this listener is down.
await startCacheInvalidation();

// Bind the port BEFORE starting workers: a second copy of the server (port already taken) must exit without having
// claimed any job — otherwise it claims work, dies, and the job later fails with "worker lease expired".
const server = createServer(handle);
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  // One shared installation. HOST=0.0.0.0 exposes it on the central machine; the default stays loopback.
  server.listen(config.port, process.env.HOST ?? "127.0.0.1", () => resolve());
}).catch(async (e: NodeJS.ErrnoException) => {
  console.error(
    e.code === "EADDRINUSE"
      ? `port ${config.port} is already in use: another platform server is running. Not starting.`
      : `cannot listen: ${e.message}`,
  );
  await instanceHeartbeat.stop().catch(() => {});
  process.exit(1);
});
console.log(`workflow platform on ${config.publicUrl} (instance ${config.instanceId})`);

// Durable scheduler: expired leases follow the persisted safe-retry/reconciliation policy.
const scheduler = startScheduler();
const telegram = startTelegramTransport();
if (config.codeIntelligence.enabled)
  background("code intelligence startup", async () => {
    for (const repo of await repositories.list())
      if (repo.provider !== "benchmark" && repo.enabled && repo.allowed_actions.includes("read"))
        await enqueueCodeIndex(repo.name).catch(() => {});
  });
startPolling();
startProdErrorSchedule();

// Graceful shutdown reconciles interrupted steps without consuming retries. A second Ctrl+C exits immediately.
let shuttingDown = false;
async function shutdown(reason: string, code: number) {
  if (shuttingDown) {
    console.log("forced exit");
    process.exit(code || 1);
  }
  shuttingDown = true;
  console.log(
    `${reason}: stopping workers; interrupted steps will be reconciled (Ctrl+C again to force)`,
  );
  server.close();
  void stopEventStream(); // open SSE responses would otherwise keep server.close() waiting
  childGroups.killAll(); // detached command process groups (go test, ...) would otherwise outlive the server
  // Releasing needs a few database round trips per step (slow over VPN): allow time, but never hang forever.
  setTimeout(() => process.exit(code), 30_000).unref();
  try {
    await telegram.stop();
    await scheduler.drain(reason);
    await settleBackground();
  } catch (e) {
    console.error("shutdown:", (e as Error).message);
  } finally {
    await instanceHeartbeat
      .stop()
      .catch((e) => console.error("instance stop:", (e as Error).message));
  }
  process.exit(code);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void shutdown(sig, 0));

// A stray rejected promise (typically a database timeout in fire-and-forget code) must not kill the server and
// every step running in it. Log it with a timestamp so it can be traced.
process.on("unhandledRejection", (reason) => {
  console.error(
    `[${new Date().toISOString()}] unhandled rejection (server kept running):`,
    reason instanceof Error ? reason.stack : reason,
  );
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
  if (maxMs > 2000)
    console.warn(
      `[${new Date().toISOString()}] event loop blocked for up to ${(maxMs / 1000).toFixed(1)}s in the last minute`,
    );
  loopDelay.reset();
}, 60_000).unref();
