import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { config } from "../../src/config.ts";

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

/**
 * Builds platform-go from go/ and runs it against this process's DATABASE_URL on a free loopback port; the
 * platform's Go client (config.retrieval.semantic.url + RETRIEVAL_INTERNAL_TOKEN) is pointed at it.
 */
export async function startPlatformGo(env: Record<string, string> = {}) {
  const bin = join(process.env.TEST_ROOT!, "platform-go");
  const build = spawnSync("go", ["build", "-o", bin, "./cmd/platform-go"], {
    cwd: resolve(import.meta.dirname, "../../go"),
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error("platform-go build failed");
  const port = await new Promise<number>((done) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });
  const token = randomBytes(32).toString("hex");
  const child = spawn(bin, [], {
    env: {
      ...process.env,
      PLATFORM_GO_ADDR: `127.0.0.1:${port}`,
      RETRIEVAL_INTERNAL_TOKEN: token,
      WORKER_ENABLED: "false",
      PLATFORM_GO_EXIT_ON_STDIN_EOF: "true",
      ...env,
    },
    stdio: ["pipe", "ignore", "inherit"],
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (
      await fetch(`${url}/readyz`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    if (i > 100 || child.exitCode !== null) throw new Error("platform-go did not become ready");
    await new Promise((r) => setTimeout(r, 100));
  }
  process.env.RETRIEVAL_INTERNAL_TOKEN = token;
  config.retrieval.semantic.url = url;
  return { pid: child.pid!, stop: () => void child.kill("SIGTERM") };
}
