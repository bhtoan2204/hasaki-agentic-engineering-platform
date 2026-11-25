import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { config } from "../config.ts";
import { log } from "../logging.ts";

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

/** The directories platform-go may read below: this server's repositories, data directory and user skills. */
export function platformTrustedRoots() {
  return [
    config.reposRoot,
    config.dataDir,
    process.env.CLAUDE_USER_SKILLS_DIR ?? join(homedir(), ".claude", "skills"),
  ]
    .map((p) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    })
    .join(delimiter);
}

/**
 * The binary to run: PLATFORM_GO_BIN when set (a prebuilt artifact, e.g. from `npm run build:go` or the Docker
 * image; never rebuilt here), otherwise the cached build under dataDir, rebuilt only when a Go source is newer.
 */
async function binary(): Promise<string | null> {
  const prebuilt = process.env.PLATFORM_GO_BIN;
  if (prebuilt) {
    if (existsSync(prebuilt)) return prebuilt;
    log.error(`PLATFORM_GO_BIN ${prebuilt} does not exist; platform-go was not started`);
    return null;
  }
  const bin = join(config.dataDir, "bin", "platform-go");
  mkdirSync(join(config.dataDir, "bin"), { recursive: true });
  if (existsSync(bin) && statSync(bin).mtimeMs >= newestGoSource()) return bin;
  return (await build(bin)) ? bin : null;
}

/** The process launcher (PROCESS_SUPERVISION_ENGINE=go) is built with platform-go, even when no service runs. */
async function ensureSupervisor() {
  const bin = join(config.dataDir, "bin", "platform-go");
  mkdirSync(join(config.dataDir, "bin"), { recursive: true });
  const sup = join(config.dataDir, "bin", "platform-supervise");
  if (existsSync(sup) && statSync(sup).mtimeMs >= newestGoSource()) return;
  if (!(await build(bin)))
    log.error("platform-supervise was not built: supervised commands will fail to start");
}

function build(bin: string) {
  return new Promise<boolean>((done) => {
    // Both binaries land in one directory: platform-go and the process launcher (ADR 0005).
    const p = spawn(
      "go",
      ["build", "-o", dirname(bin) + "/", "./cmd/platform-go", "./cmd/platform-supervise"],
      {
        cwd: goDir,
        stdio: "inherit",
      },
    );
    p.on("error", (e) => (log.error("platform-go build:", e.message), done(false)));
    p.on("exit", (code) => done(code === 0));
  });
}

/**
 * Supervises platform-go next to the server when its
 * URL is on this machine. Any failure only logs: retrieval then stays lexical, and the features served by platform-go
 * (analytics, code intelligence, knowledge scans, production error scans) answer "unavailable" until it is back.
 */
export function startGoService() {
  const url = new URL(config.retrieval.semantic.url);
  let child: ChildProcess | null = null;
  let stopping = false;
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (config.supervision.engine === "go" && !process.env.PLATFORM_SUPERVISE_BIN)
    void ensureSupervisor();
  // Analytics, code intelligence, knowledge scans and production error scans all run in platform-go: always start it.
  if (local) {
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
          PROD_ERRORS_ENGINE: "go",
          PLATFORM_INTERNAL_URL: `http://127.0.0.1:${config.port}`,
          PLATFORM_GO_EXIT_ON_STDIN_EOF: "true",
          // Code search and knowledge scans read only below these (ADR 0006, 0007), whatever a request names.
          PLATFORM_TRUSTED_ROOTS: platformTrustedRoots(),
        },
        // The open stdin pipe is the liveness link: platform-go exits when this process dies.
        stdio: ["pipe", "inherit", "inherit"],
      });
      child.on("error", (e) => log.error("platform-go:", e.message));
      child.on("exit", (code, signal) => {
        child = null;
        if (stopping) return;
        delay = Date.now() - started > 60_000 ? 1000 : Math.min(delay * 2, 60_000);
        log.error(`platform-go exited (${signal ?? code}); restarting in ${delay / 1000}s`);
        setTimeout(run, delay).unref();
      });
    };
    void binary().then((found) => {
      if (found && !stopping) {
        bin = found;
        run();
      } else if (!found)
        log.error(
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
