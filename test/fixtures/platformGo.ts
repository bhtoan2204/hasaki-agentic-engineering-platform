import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import pg from "pg";
import { adminUrl, sharedTestCluster } from "../pg-cluster.ts";
import { config } from "../../src/config.ts";
import { platformTrustedRoots } from "../../src/retrieval/goService.ts";

export const goToolchain = () => spawnSync("go", ["version"]).status === 0;

/**
 * Cross-language suites are mandatory: without a Go toolchain they fail, so CI can never pass by skipping them.
 * PLATFORM_ALLOW_MISSING_GO=1 turns the failure into an explicit, reported skip on a machine without Go.
 */
export function requireGoToolchain(suite: string) {
  if (process.env.PLATFORM_ALLOW_MISSING_GO === "1" && !process.env.CI)
    test(suite, { skip: "Go toolchain not installed (PLATFORM_ALLOW_MISSING_GO=1)" }, () => {});
  else
    test(suite, () => {
      throw new Error(
        "Go toolchain not found: install Go (go/go.mod) or set PLATFORM_ALLOW_MISSING_GO=1 to skip locally",
      );
    });
}

function buildPlatformGo(bin: string, directory: string) {
  const temporary = mkdtempSync(join(directory, "platform-go-build-"));
  try {
    const output = join(temporary, "platform-go");
    const build = spawnSync("go", ["build", "-o", output, "./cmd/platform-go"], {
      cwd: resolve(import.meta.dirname, "../../go"),
      stdio: "inherit",
    });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error("platform-go build failed");
    renameSync(output, bin);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function platformGoBinary() {
  const cluster = sharedTestCluster();
  const directory = cluster ?? process.env.TEST_ROOT!;
  const bin = join(directory, "platform-go");
  if (existsSync(bin)) return bin;
  if (!cluster) {
    buildPlatformGo(bin, directory);
    return bin;
  }
  // Only the binary is shared within the private cluster. The session lock releases even if a test process exits.
  const client = new pg.Client({
    connectionString: adminUrl(cluster),
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('test/fixtures/platformGo.ts'), 1)");
    if (!existsSync(bin)) buildPlatformGo(bin, directory);
    return bin;
  } finally {
    await client.end();
  }
}

/** Run a fresh platform-go instance for this test's database, credentials and loopback endpoint. */
export async function startPlatformGo(env: Record<string, string> = {}) {
  const bin = await platformGoBinary();
  const port = await new Promise<number>((done) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });
  // Every instance shares the platform's token, as under the supervisor (the gateway accepts exactly one).
  const existing = process.env.RETRIEVAL_INTERNAL_TOKEN ?? "";
  const token = existing.length >= 32 ? existing : randomBytes(32).toString("hex");
  const child = spawn(bin, [], {
    env: {
      ...process.env,
      PLATFORM_GO_ADDR: `127.0.0.1:${port}`,
      RETRIEVAL_INTERNAL_TOKEN: token,
      WORKER_ENABLED: "false",
      PLATFORM_GO_EXIT_ON_STDIN_EOF: "true",
      PLATFORM_TRUSTED_ROOTS: platformTrustedRoots(),
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // platform-go logs JSON to stdout: only the tail is kept (stderr is forwarded), so a service that never becomes
  // ready says why in the failure itself.
  let logTail = "";
  const keep = (b: Buffer) => (logTail = (logTail + b.toString()).slice(-2000));
  child.stdout!.on("data", keep);
  child.stderr!.on("data", (b: Buffer) => (process.stderr.write(b), keep(b)));
  const url = `http://127.0.0.1:${port}`;
  let spawnError: Error | undefined;
  child.once("error", (error) => (spawnError = error));
  try {
    for (let i = 0; ; i++) {
      if (spawnError) throw spawnError;
      if (i > 100 || child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `platform-go did not become ready (exit ${child.exitCode ?? child.signalCode ?? "none"}): ${logTail.trim().split("\n").slice(-3).join(" | ")}`,
        );
      if (
        await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(1000) }).then(
          (r) => r.ok,
          () => false,
        )
      )
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  process.env.RETRIEVAL_INTERNAL_TOKEN = token;
  config.retrieval.semantic.url = url;
  return { pid: child.pid!, stop: () => void child.kill("SIGTERM") };
}
