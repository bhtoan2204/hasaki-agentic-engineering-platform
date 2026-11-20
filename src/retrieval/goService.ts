import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../config.ts";

const goDir = resolve(import.meta.dirname, "../../go");

/** Newest modification time of the Go module's build inputs (sources, cgo grammar, go.mod/go.sum). */
export function newestGoSource(dir = goDir): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "testdata" && !entry.name.startsWith("."))
        newest = Math.max(newest, newestGoSource(path));
    } else if (/\.(go|c|h)$|^go\.(mod|sum)$/.test(entry.name) && !entry.name.endsWith("_test.go"))
      newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

/**
 * The binary to run: PLATFORM_GO_BIN when set (a prebuilt artifact, e.g. from `npm run build:go` or the Docker
 * image; never rebuilt here), otherwise the cached build under dataDir, rebuilt only when a Go source is newer.
 */
async function binary(): Promise<string | null> {
  const prebuilt = process.env.PLATFORM_GO_BIN;
  if (prebuilt) {
    if (existsSync(prebuilt)) return prebuilt;
    console.error(`PLATFORM_GO_BIN ${prebuilt} does not exist; platform-go was not started`);
    return null;
  }
  const bin = join(config.dataDir, "bin", "platform-go");
  mkdirSync(join(config.dataDir, "bin"), { recursive: true });
  if (existsSync(bin) && statSync(bin).mtimeMs >= newestGoSource()) return bin;
  return (await build(bin)) ? bin : null;
}

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
 * Supervises platform-go next to the server when semantic retrieval, Go indexing or Go analytics is enabled and its
 * URL is on this machine. Any failure only logs: retrieval then stays lexical, Go indexing jobs fail and retry, and
 * analytics falls back to TypeScript (bounded).
 */
export function startGoService() {
  const url = new URL(config.retrieval.semantic.url);
  let child: ChildProcess | null = null;
  let stopping = false;
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  // Semantic retrieval, Go indexing and Go analytics are all served by platform-go; each flag needs it on its own.
  const needed =
    config.retrieval.semantic.enabled ||
    config.codeIntelligence.engine === "go" ||
    config.analytics.engine === "go" ||
    config.prodErrors.engine === "go";
  if (needed && local) {
    let bin = "";
    let delay = 1000;
    const run = () => {
      const started = Date.now();
      child = spawn(bin, [], {
        // DATABASE_POOL_MAX belongs to the Node pool; the Go service keeps its own small pool.
        env: {
          ...process.env,
          PLATFORM_GO_ADDR: `${url.hostname}:${url.port || 80}`,
          DATABASE_POOL_MAX: "4",
          // Production error scans (ADR 0004) reach the providers through this server's internal gateway.
          PROD_ERRORS_ENGINE: config.prodErrors.engine,
          PLATFORM_INTERNAL_URL: `http://127.0.0.1:${config.port}`,
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
    void binary().then((found) => {
      if (found && !stopping) {
        bin = found;
        run();
      } else if (!found)
        console.error(
          "platform-go was not started; semantic retrieval stays lexical and Go engines fall back or fail",
        );
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
