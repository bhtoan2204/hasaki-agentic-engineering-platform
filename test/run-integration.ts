/**
 * `node test/run-integration.ts [node --test options] <files>`: starts ONE private PostgreSQL cluster, runs the files
 * with the test/setup.ts preload (each file copies the migrated template into its own database on that cluster) and
 * removes the cluster at the end, also on failure or Ctrl-C.
 */
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { CLUSTER_ENV, startTestCluster } from "./pg-cluster.ts";

const cluster = startTestCluster();
const child = spawn(
  process.execPath,
  [
    "--disable-warning=ExperimentalWarning",
    "--import",
    "./test/setup.ts",
    "--test",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit", env: { ...process.env, [CLUSTER_ENV]: cluster } },
);
// Wait for the child, so the cluster outlives every test process; exit then stops it. Ctrl-C already reached the
// child through the shared process group, so only SIGTERM is forwarded.
process.removeAllListeners("SIGINT").on("SIGINT", () => {});
process.removeAllListeners("SIGTERM").on("SIGTERM", () => child.kill("SIGTERM"));
child.on("error", () => process.exit(1));
child.on("exit", (code, signal) =>
  process.exit(code ?? (signal ? 128 + constants.signals[signal] : 1)),
);
