import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../config.ts";

const goDir = resolve(import.meta.dirname, "../../go");

function build(bin: string) {
  return new Promise<boolean>((done) => {
    const p = spawn("go", ["build", "-o", bin, "./cmd/platform-go"], {
      cwd: goDir,
      stdio: "inherit",
    });
    p.on("error", (e) => (console.error("platform-go build:", e.message), done(false)));
    p.on("exit", (code) => done(code === 0));
  });
}

/**
 * Builds and supervises platform-go next to the server when semantic retrieval or Go indexing is enabled and its URL
 * is on this machine. Any failure only logs: retrieval then stays lexical, and Go indexing jobs fail and retry.
 */
export function startGoService() {
  const url = new URL(config.retrieval.semantic.url);
  let child: ChildProcess | null = null;
  let stopping = false;
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  // Semantic retrieval and Go indexing are both served by platform-go.
  const needed = config.retrieval.semantic.enabled || config.codeIntelligence.engine === "go";
  if (needed && local) {
    const bin = join(config.dataDir, "bin", "platform-go");
    mkdirSync(join(config.dataDir, "bin"), { recursive: true });
    let delay = 1000;
    const run = () => {
      const started = Date.now();
      child = spawn(bin, [], {
        // DATABASE_POOL_MAX belongs to the Node pool; the Go service keeps its own small pool.
        env: {
          ...process.env,
          PLATFORM_GO_ADDR: `${url.hostname}:${url.port || 80}`,
          DATABASE_POOL_MAX: "4",
          PLATFORM_GO_EXIT_ON_STDIN_EOF: "true",
        },
        // The open stdin pipe is the liveness link: platform-go exits when this process dies.
        stdio: ["pipe", "inherit", "inherit"],
      });
      child.on("error", (e) => console.error("platform-go:", e.message));
      child.on("exit", (code, signal) => {
        child = null;
        if (stopping) return;
        delay = Date.now() - started > 60_000 ? 1000 : Math.min(delay * 2, 60_000);
        console.error(`platform-go exited (${signal ?? code}); restarting in ${delay / 1000}s`);
        setTimeout(run, delay).unref();
      });
    };
    void build(bin).then((ok) => {
      if (ok && !stopping) run();
      else if (!ok) console.error("platform-go was not started; semantic retrieval stays lexical");
    });
  }
  return {
    stop: () =>
      new Promise<void>((done) => {
        stopping = true;
        const c = child;
        if (!c) return done();
        c.once("exit", () => done());
        c.kill("SIGTERM");
        setTimeout(() => (c.kill("SIGKILL"), done()), 12_000).unref();
      }),
  };
}
