/**
 * A private PostgreSQL cluster (initdb + pg_ctl) on a temporary Unix socket, owned by the calling process and removed
 * when it exits. test/run-integration.ts starts one per run and shares it via CLUSTER_ENV; test/setup.ts starts its own
 * when run alone.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

export const CLUSTER_ENV = "CTP_TEST_PG_CLUSTER";

export const adminUrl = (cluster: string) =>
  `postgres://platform_test@localhost/postgres?host=${encodeURIComponent(cluster)}`;

/** The cluster shared by test/run-integration.ts, or null. Refuses anything that is not a test-owned cluster. */
export function sharedTestCluster(): string | null {
  const cluster = process.env[CLUSTER_ENV];
  if (!cluster) return null;
  if (
    !isAbsolute(cluster) ||
    dirname(cluster) !== tmpdir() ||
    !basename(cluster).startsWith("ctp-pg-") ||
    !existsSync(join(cluster, "data", "PG_VERSION"))
  )
    throw new Error(`${CLUSTER_ENV} does not name a test-owned PostgreSQL cluster`);
  return cluster;
}

export function startTestCluster(): string {
  // Never connect to an inherited database, even on localhost: another application may own it.
  const cluster = mkdtempSync(join(tmpdir(), "ctp-pg-"));
  const clusterData = join(cluster, "data");
  let clusterStarted = false;
  function stopCluster() {
    if (clusterStarted) {
      const stopped = spawnSync("pg_ctl", ["-D", clusterData, "-m", "immediate", "-w", "stop"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
      });
      if (stopped.status !== 0) return; // Keep diagnostics if PostgreSQL could not stop.
      clusterStarted = false;
    }
    rmSync(cluster, { recursive: true, force: true });
  }
  process.once("exit", stopCluster);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      stopCluster();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  for (const [command, args] of [
    [
      "initdb",
      ["-D", clusterData, "-U", "platform_test", "-A", "trust", "--no-locale", "--encoding=UTF8"],
    ],
    [
      "pg_ctl",
      [
        "-D",
        clusterData,
        "-l",
        join(cluster, "server.log"),
        "-o",
        `-c listen_addresses='' -c unix_socket_directories='${cluster}' -c shared_buffers=16MB -c max_connections=300`,
        "-w",
        "start",
      ],
    ],
  ] as const) {
    const result = spawnSync(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    if (result.status !== 0)
      throw new Error(
        `Test-owned PostgreSQL ${command} failed (${result.status}): ${result.error?.message ?? ""} ${result.stderr}\n${existsSync(join(cluster, "server.log")) ? readFileSync(join(cluster, "server.log"), "utf8") : ""}`,
      );
    if (command === "pg_ctl") clusterStarted = true;
  }
  return cluster;
}
