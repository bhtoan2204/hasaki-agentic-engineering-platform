import { startTelegramTransport } from "./telegram/transport.ts";
import { pruneLoginAttempts } from "./auth/sessions.ts";
import { keyRing, writeFormat } from "./auth/crypto.ts";
import { enforceAutonomyTimeouts } from "./chat/autonomy.ts";
import { radarTick } from "./radar/scan.ts";
import { dispatchDelegations } from "./workflow/delegationDispatch.ts";
import { invalidateCausalMemories } from "./memory/causal.ts";
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
import { registerReconcileTask, startScheduler } from "./workflow/scheduler.ts";
import { runMemoryAgingThrottled } from "./knowledge/aging.ts";
import { settleSharedAnalyses } from "./sharing/settle.ts";
import { dispatchIntake } from "./workitems/intake.ts";
import { syncPullRequestLifecycles } from "./workflow/prLifecycle.ts";
import { startCacheInvalidation, stopCacheInvalidation } from "./cache/index.ts";
import { syncRepositoriesFromConfig } from "./repos/service.ts";
import { seedKnowledge } from "./knowledge/service.ts";
import { startEventStream, stopEventStream } from "./api/stream.ts";
import { startGoService } from "./retrieval/goService.ts";
import { stopChatStream } from "./chat/events.ts";
import { recoverInstanceTurns } from "./chat/runtime.ts";
import { childGroups } from "./workflow/local.ts";
import { delegatedScopeAvailable, stopSupervised } from "./agent/process/supervisor.ts";
import { log } from "./logging.ts";
import { ignoreError } from "./ignoreError.ts";

// The Claude Agent SDK (and detect-libc) call process.report.getReport() to tell glibc from musl. By default a report
// resolves every open socket's peer with a SYNCHRONOUS reverse-DNS lookup on the main thread; over VPN each lookup
// times out (5 s), so with the DB pool and SSE sockets open the whole server froze for minutes at every agent start.
(process.report as NodeJS.ProcessReport & { excludeNetwork: boolean }).excludeNetwork = true; // Node ≥ 22.13; older @types lack it

// Node gives each address of a host only 250 ms to connect before trying the next ("happy eyeballs"), and fails the
// whole connection when every attempt is cut short. Without an IPv6 route (WSL) and with a distant server (Telegram:
// ~1 s to connect from here), every outbound fetch to it failed with ETIMEDOUT after ~280 ms — the Telegram receiver
// logged that as "Telegram API error 503". Give each address 2.5 s; a real outage still fails at the caller's timeout.
setDefaultAutoSelectFamilyAttemptTimeout(2500);

try {
  keyRing();
  writeFormat();
} catch (e) {
  log.error(`${(e as Error).message}. Refusing to start.`);
  process.exit(1);
}

const applied = await migrate();
if (applied.length) log.info(`migrations applied: ${applied.join(", ")}`);
const instanceHeartbeat = await startInstanceHeartbeat({
  waitForPrevious: true,
  onWait: (seconds) =>
    log.info(
      `Waiting ${seconds}s for the previous instance registration to expire. An active installation will remain protected.`,
    ),
});
await seedTemplates();
await syncRepositoriesFromConfig();
for (const warning of await validateLocalConfiguration()) log.warn(`Startup warning: ${warning}`);
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
  server.listen(config.port, config.server.host ?? "127.0.0.1", () => resolve());
}).catch(async (e: NodeJS.ErrnoException) => {
  log.error(
    e.code === "EADDRINUSE"
      ? `port ${config.port} is already in use: another platform server is running. Not starting.`
      : `cannot listen: ${e.message}`,
  );
  await instanceHeartbeat.stop().catch(ignoreError("server.heartbeat_stop"));
  process.exit(1);
});
log.info(`workflow platform on ${config.publicUrl} (instance ${config.instanceId})`);

// Durable scheduler: expired leases follow the persisted safe-retry/reconciliation policy.
// Policy-controlled intake rides the scheduler's reconcile tick: re-triage and start eligible items (no-op without a policy).
registerReconcileTask("intake", () => dispatchIntake());
registerReconcileTask("memory_aging", () => runMemoryAgingThrottled());
// Shared results: publish or fail analyses whose run ended (no-op while both SHARED_RESULTS_* flags are off).
registerReconcileTask("shared_results", () => settleSharedAnalyses());
// PR delivery lifecycle (no-op while prLifecycle.mode is "off"): bounded polling with per-PR backoff.
registerReconcileTask("pull_request_lifecycle", syncPullRequestLifecycles);
// Chat autonomy: runs started by an autonomy policy that outlive its timeout are paused for the owner.
registerReconcileTask("chat_autonomy", enforceAutonomyTimeouts);
// Engineering Radar: interval-gated deterministic detection over stored signals → findings → Intake Queue.
registerReconcileTask("engineering_radar", radarTick);
// Workflow-to-workflow delegation: spawn queued children, record finished ones, resume waiting parents, cascade cancels.
registerReconcileTask("workflow_delegation", dispatchDelegations);
// Causal memory: records whose cited files changed on the base become "outdated" (bounded, every 30 minutes).
let causalCheckedAt = 0;
registerReconcileTask("causal_memory", async () => {
  if (Date.now() - causalCheckedAt < 30 * 60_000) return;
  causalCheckedAt = Date.now();
  await invalidateCausalMemories();
});
// Failed/successful login attempts past retention are deleted in bounded batches (every 10 minutes).
let loginAttemptsPrunedAt = 0;
registerReconcileTask("login_attempts", async () => {
  if (Date.now() - loginAttemptsPrunedAt < 10 * 60_000) return;
  loginAttemptsPrunedAt = Date.now();
  for (let batch = 0; batch < 20; batch++) if ((await pruneLoginAttempts()) < 5000) break;
});
const scheduler = startScheduler();
const telegram = startTelegramTransport();
const goService = startGoService();
// Probed off the launch path so the first supervised start does not wait for systemd-run.
if (config.supervision.engine === "go") void delegatedScopeAvailable();
if (config.codeIntelligence.enabled)
  background("code intelligence startup", async () => {
    for (const repo of await repositories.list())
      if (repo.provider !== "benchmark" && repo.enabled && repo.allowed_actions.includes("read"))
        await enqueueCodeIndex(repo.name).catch(() => {});
  });
startPolling();
startProdErrorSchedule();
void recoverInstanceTurns().catch((e) => log.error("chat turn recovery:", (e as Error).message));

// Graceful shutdown reconciles interrupted steps without consuming retries. A second Ctrl+C exits immediately.
let shuttingDown = false;
async function shutdown(reason: string, code: number) {
  if (shuttingDown) {
    log.info("forced exit");
    process.exit(code || 1);
  }
  shuttingDown = true;
  log.info(
    `${reason}: stopping workers; interrupted steps will be reconciled (Ctrl+C again to force)`,
  );
  server.close();
  void stopEventStream(); // open SSE responses would otherwise keep server.close() waiting
  void stopChatStream();
  void stopCacheInvalidation(); // the last subscriber closes the shared LISTEN connection
  childGroups.killAll(); // detached command process groups (go test, ...) would otherwise outlive the server
  void stopSupervised(); // Go launchers clean up their cgroup (they also do by themselves when this process dies)
  // Releasing needs a few database round trips per step (slow over VPN): allow time, but never hang forever.
  setTimeout(() => process.exit(code), 30_000).unref();
  try {
    await telegram.stop();
    await goService.stop();
    await scheduler.drain(reason);
    await settleBackground();
  } catch (e) {
    log.error("shutdown:", (e as Error).message);
  } finally {
    await instanceHeartbeat.stop().catch((e) => log.error("instance stop:", (e as Error).message));
  }
  process.exit(code);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void shutdown(sig, 0));

// A stray rejected promise (typically a database timeout in fire-and-forget code) must not kill the server and
// every step running in it. Log it with a timestamp so it can be traced.
process.on("unhandledRejection", (reason) => {
  log.error(
    `[${new Date().toISOString()}] unhandled rejection (server kept running):`,
    reason instanceof Error ? reason.stack : reason,
  );
});
// A thrown exception leaves the process in an unknown state: log it, hand running steps back, then exit.
process.on("uncaughtException", (e) => {
  log.error(`[${new Date().toISOString()}] uncaught exception:`, e.stack ?? e);
  void shutdown("uncaught exception", 1);
});

// Event-loop stalls freeze everything at once (heartbeats, agent sessions, HTTP): report them when they happen.
const loopDelay = monitorEventLoopDelay({ resolution: 50 });
loopDelay.enable();
setInterval(() => {
  const maxMs = loopDelay.max / 1e6;
  if (maxMs > 2000)
    log.warn(
      `[${new Date().toISOString()}] event loop blocked for up to ${(maxMs / 1000).toFixed(1)}s in the last minute`,
    );
  loopDelay.reset();
}, 60_000).unref();
