/**
 * Language-server sessions (P1-B, ADR 0009). One session per (language, workspace root, workspace fingerprint): an
 * edit anywhere in the worktree changes the fingerprint and retires the old session, so an answer never comes from a
 * server that saw another state. Bounded (`lsp.maxSessions`, least recently used evicted), closed when idle
 * (`lsp.idleMs`), replaced when it dies.
 *
 * Servers run inside the OS sandbox profile (root bound read-only, no network, masked HOME/data/credentials,
 * allowlisted env) when the host has it; otherwise only with the operator opt-in `lsp.allowUnsandboxed`. Go runs with
 * GOPROXY=off, -mod=readonly, GOTOOLCHAIN=local, CGO_ENABLED=0, GOWORK=off: no download, no toolchain switch, no cgo.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "../../config.ts";
import {
  isolatedEnvironment,
  probeIsolation,
  sandboxInvocation,
  SANDBOX_HOME,
} from "../../agent/isolation.ts";
import { LspClient, type LspCommand } from "./client.ts";
import { ignoreError } from "../../ignoreError.ts";

export type Language = "go" | "ts";
export class LspUnavailable extends Error {}

const TS_SERVER = realpathSync(fileURLToPath(new URL("./tsServer.mjs", import.meta.url)));
const TYPESCRIPT_DIR = dirname(
  dirname(realpathSync(createRequire(import.meta.url).resolve("typescript"))),
);

interface Entry {
  key: string;
  language: Language;
  root: string;
  client: Promise<LspClient>;
  lastUsed: number;
  idle?: ReturnType<typeof setTimeout>;
}
const sessions = new Map<string, Entry>();

function onPath(bin: string) {
  if (bin.includes("/")) return existsSync(bin) ? bin : null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const p = join(dir, bin);
    if (dir && existsSync(p)) return p;
  }
  return null;
}

const GO_ENV = {
  GOPROXY: "off",
  GOFLAGS: "-mod=readonly",
  GOTOOLCHAIN: "local",
  CGO_ENABLED: "0",
  GOWORK: "off",
  GOTELEMETRY: "off",
};

async function commandFor(language: Language, root: string): Promise<LspCommand> {
  const base = join(config.dataDir, "sandbox");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const home = mkdtempSync(join(base, "lsp-"));
  const cleanup = () => rmSync(home, { recursive: true, force: true });
  let command: string;
  let args: string[];
  if (language === "go") {
    const gopls = onPath(config.lsp.gopls || "gopls");
    if (!gopls) {
      cleanup();
      throw new LspUnavailable(`gopls is not installed (${config.lsp.gopls || "gopls"} not found)`);
    }
    command = realpathSync(gopls);
    args = [];
  } else {
    command = process.execPath;
    args = ["--no-warnings", TS_SERVER];
  }
  const runtime = await probeIsolation();
  if (runtime.available) {
    const inv = sandboxInvocation(
      runtime,
      {
        cwd: root,
        writable: [],
        readOnly: [root, dirname(TS_SERVER), TYPESCRIPT_DIR, dirname(dirname(command))],
        home,
        limits: { memoryMb: 1536, pids: 256, cpuSeconds: 3600, fileSizeMb: 256 },
      },
      command,
      args,
    );
    return {
      command: inv.command,
      args: inv.args,
      env: {
        ...inv.env,
        ...isolatedEnvironment(
          null,
          language === "go"
            ? { ...GO_ENV, GOCACHE: `${SANDBOX_HOME}/gocache`, GOPATH: `${SANDBOX_HOME}/go` }
            : {},
        ),
      },
      cwd: root,
      cleanup,
    };
  }
  if (!config.lsp.allowUnsandboxed) {
    cleanup();
    throw new LspUnavailable(
      `the OS sandbox is unavailable (${runtime.problems.join("; ")}) and lsp.allowUnsandboxed is off`,
    );
  }
  const env = isolatedEnvironment(
    null,
    language === "go"
      ? { ...GO_ENV, GOCACHE: join(home, "gocache"), GOPATH: join(home, "go") }
      : {},
  );
  return { command, args, env: { ...env, HOME: home, TMPDIR: home }, cwd: root, cleanup };
}

function scheduleIdle(e: Entry) {
  if (e.idle) clearTimeout(e.idle);
  e.idle = setTimeout(() => void retire(e), config.lsp.idleMs);
  e.idle.unref();
}

async function retire(e: Entry) {
  if (sessions.get(e.key) === e) sessions.delete(e.key);
  if (e.idle) clearTimeout(e.idle);
  await e.client.then((c) => c.close()).catch(ignoreError("lsp.session_close"));
}

/** A live session for this exact workspace state, started (and its predecessors retired) if needed. */
export async function getSession(language: Language, root: string, fingerprint: string) {
  const key = `${language}\0${root}\0${fingerprint}`;
  let e = sessions.get(key);
  if (e) {
    const client = await e.client.catch(() => null);
    if (client?.alive) {
      e.lastUsed = Date.now();
      scheduleIdle(e);
      return client;
    }
    await retire(e);
  }
  for (const other of [...sessions.values()])
    if (other.language === language && other.root === root) void retire(other); // older workspace state
  while (sessions.size >= config.lsp.maxSessions) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
    await retire(oldest);
  }
  const client = commandFor(language, root).then((cmd) =>
    LspClient.start(cmd, pathToFileURL(root).href, config.lsp.startupTimeoutMs),
  );
  e = { key, language, root, client, lastUsed: Date.now() };
  sessions.set(key, e);
  scheduleIdle(e);
  try {
    return await client;
  } catch (err) {
    await retire(e);
    throw err;
  }
}

export const sessionCount = () => sessions.size;

export async function closeAllSessions() {
  await Promise.all([...sessions.values()].map(retire));
}

/** Tests only: simulate a crash of every running server. */
export function killSessionsForTests() {
  for (const e of sessions.values())
    void e.client.then((c) => c.kill()).catch(ignoreError("lsp.kill_for_tests"));
}

/** Tests only: process ids of the running servers. */
export async function sessionPidsForTests() {
  const clients = await Promise.all([...sessions.values()].map((e) => e.client.catch(() => null)));
  return clients.map((c) => c?.pid).filter((p): p is number => typeof p === "number");
}
