/**
 * CodeAct executor (P1-A, ADR 0008): runs one short program in the OS sandbox and brokers its tool calls.
 *
 * The program never reaches a tool by itself. Every `platform.callTool(name, args)` arrives here as a request; the
 * broker resolves `name` exactly against the caller-supplied tool list, refuses anything that is not read-only, applies
 * the call/byte/concurrency budgets and a per-call deadline, then hands the call to the surface (`deps.call`), which goes
 * through the platform's own registry and authorization (src/codeact/surfaces.ts). Nothing the program sends can widen
 * that: names are matched exactly, read-only is decided by the registry entry, identity comes from the surface.
 *
 * The program runs under `sandboxLauncher` (cgroup scope → prlimit → bubblewrap without network, masked HOME, data
 * directory, repositories and credentials, allowlisted environment) with Node's permission model on top. Without a
 * usable isolation runtime there is no launcher and execution fails closed: code never runs in the worker.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.ts";
import { isolatedEnvironment, probeIsolation, sandboxInvocation } from "../agent/isolation.ts";

export type Category =
  | "unsupported"
  | "unauthorized"
  | "invalid_input"
  | "budget_exceeded"
  | "timeout"
  | "canceled"
  | "dependency_unavailable"
  | "internal";

export interface CodeActTool {
  name: string;
  summary: string;
  readOnly: boolean;
}
export type CodeActCall = (
  name: string,
  args: unknown,
  signal: AbortSignal,
) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
/** Builds the command that runs `node <args>` (the runner). Throws a CodeActError when it cannot be done safely. */
export type Launcher = (
  node: string,
  args: string[],
) => Promise<{
  command: string;
  args: string[];
  env: Record<string, string>;
  cleanup?: () => void;
}>;

export interface CallRecord {
  seq: number;
  tool: string;
  status: "ok" | "error" | "denied" | "timeout";
  category?: Category;
  ms: number;
  input_sha256: string;
  output_sha256?: string;
  bytes: number;
  read_only: boolean;
}
export interface CodeActResult {
  ok: boolean;
  value?: unknown;
  truncated?: boolean;
  error?: string;
  category?: Category;
  calls: CallRecord[];
  stats: { duration_ms: number; calls: number; result_bytes: number };
}

export class CodeActError extends Error {
  readonly category: Category;
  constructor(category: Category, message: string) {
    super(message);
    this.category = category;
  }
}

export const RUNNER = realpathSync(fileURLToPath(new URL("./runner.mjs", import.meta.url)));
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** Key-sorted JSON, so the same arguments always have the same fingerprint. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

let testLauncher: Launcher | undefined;
/** Tests only: run programs in a plain child process (surface wiring tests on hosts without the OS sandbox). */
export function setCodeActLauncherForTests(launcher: Launcher | undefined) {
  testLauncher = launcher;
}

/** Enabled by the operator and the OS sandbox usable on this host right now; otherwise the reason. */
export async function codeActAvailability(): Promise<true | string> {
  if (!config.codeAct.enabled) return "CodeAct is disabled on this installation (codeAct.enabled)";
  if (testLauncher) return true;
  const runtime = await probeIsolation();
  if (!runtime.available)
    return `CodeAct needs the OS sandbox, which is unavailable here: ${runtime.problems.join("; ")}`;
  return true;
}

/** The production launcher: the existing agent sandbox profile, no network, no writable paths but a private HOME. */
export const sandboxLauncher: Launcher = async (node, args) => {
  const runtime = await probeIsolation();
  if (!runtime.available)
    throw new CodeActError(
      "dependency_unavailable",
      `OS isolation unavailable: ${runtime.problems.join("; ")}`,
    );
  const base = join(config.dataDir, "sandbox");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const home = mkdtempSync(join(base, "codeact-"));
  const inv = sandboxInvocation(
    runtime,
    {
      cwd: "/tmp",
      writable: [],
      readOnly: [dirname(RUNNER)],
      home,
      limits: {
        memoryMb: config.codeAct.memoryMb + 64,
        pids: 64,
        cpuSeconds: Math.ceil(config.codeAct.timeoutMs / 1000) + 5,
        fileSizeMb: 1,
      },
    },
    node,
    args,
  );
  return {
    command: inv.command,
    args: inv.args,
    env: { ...inv.env, ...isolatedEnvironment(null) },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
};

/** Run one program. Never throws: every outcome is a CodeActResult with a category. */
export async function executeCode(
  req: { code: string; timeoutMs?: number },
  deps: {
    tools: () => CodeActTool[];
    call: CodeActCall;
    signal?: AbortSignal;
    launch?: Launcher;
    /** Persistence hook for each nested call (the surface stores it with the redacted result). */
    record?: (c: CallRecord, result: unknown, error?: string) => Promise<void> | void;
  },
): Promise<CodeActResult> {
  const lim = config.codeAct;
  const started = Date.now();
  const calls: CallRecord[] = [];
  let resultBytes = 0;
  const outcome = (r: Partial<CodeActResult> & { ok: boolean }): CodeActResult => ({
    ...r,
    calls: calls.filter(Boolean),
    stats: {
      duration_ms: Date.now() - started,
      calls: calls.filter(Boolean).length,
      result_bytes: resultBytes,
    },
  });
  const fail = (category: Category, error: string) => outcome({ ok: false, category, error });

  if (typeof req.code !== "string" || !req.code.trim())
    return fail("invalid_input", "code is empty");
  if (Buffer.byteLength(req.code) > lim.maxCodeBytes)
    return fail("invalid_input", `code exceeds ${lim.maxCodeBytes} bytes`);
  if (deps.signal?.aborted) return fail("canceled", "execution canceled before it started");
  const timeoutMs = Math.max(100, Math.min(req.timeoutMs ?? lim.timeoutMs, lim.timeoutMs));

  const nodeArgs = [
    "--permission",
    `--allow-fs-read=${RUNNER}`,
    `--max-old-space-size=${Math.max(32, Math.floor(lim.memoryMb * 0.75))}`,
    "--no-warnings",
    RUNNER,
  ];
  let inv: Awaited<ReturnType<Launcher>>;
  try {
    inv = await (deps.launch ?? testLauncher ?? sandboxLauncher)(process.execPath, nodeArgs);
  } catch (e) {
    return fail(
      e instanceof CodeActError ? e.category : "dependency_unavailable",
      (e as Error).message,
    );
  }

  const child = spawn(inv.command, inv.args, {
    env: inv.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const nested = new AbortController();
  let settled = false;
  let issued = 0;
  let inflight = 0;
  const waiting: Array<() => void> = [];
  let stderrTail = "";

  return await new Promise<CodeActResult>((resolve) => {
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const finish = (r: CodeActResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      deps.signal?.removeEventListener("abort", onAbort);
      nested.abort();
      kill();
      try {
        inv.cleanup?.();
      } catch {
        /* best effort: a private temp HOME */
      }
      resolve(r);
    };
    const send = (m: unknown) => {
      if (!settled && child.stdin.writable) child.stdin.write(`${JSON.stringify(m)}\n`);
    };
    const timer = setTimeout(
      () => finish(fail("timeout", `the program exceeded ${timeoutMs} ms`)),
      timeoutMs,
    );
    const onAbort = () => finish(fail("canceled", "execution canceled"));
    deps.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (e) => finish(fail("dependency_unavailable", e.message)));
    child.stdin.on("error", () => {});
    child.stderr.on("data", (b: Buffer) => {
      stderrTail = (stderrTail + b.toString()).slice(-2000);
    });
    child.on("close", (code) =>
      finish(
        fail(
          "internal",
          `the program ended without a result (exit ${code ?? "signal"})${stderrTail.trim() ? `: ${stderrTail.trim().split("\n").slice(-2).join(" | ")}` : ""}`,
        ),
      ),
    );

    let buffer = "";
    const lineLimit = lim.maxResultBytes + lim.maxOutputBytes + 65536;
    child.stdout.on("data", (b: Buffer) => {
      buffer += b.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handle(line);
      }
      if (buffer.length > lineLimit)
        finish(fail("budget_exceeded", "the program wrote more output than allowed"));
    });

    const handle = (line: string) => {
      let m: {
        t?: string;
        id?: unknown;
        name?: unknown;
        args?: unknown;
        value?: unknown;
        error?: unknown;
        category?: unknown;
      };
      try {
        m = JSON.parse(line);
      } catch {
        return; // not protocol: ignored
      }
      if (m.t === "list")
        send({
          t: "tools",
          tools: deps
            .tools()
            .filter((t) => t.readOnly)
            .map(({ name, summary }) => ({ name, summary })),
        });
      else if (m.t === "call") void brokerCall(m.id, m.name, m.args);
      else if (m.t === "done") {
        const text = JSON.stringify(m.value ?? null);
        if (text.length > lim.maxOutputBytes)
          finish(outcome({ ok: true, value: text.slice(0, lim.maxOutputBytes), truncated: true }));
        else finish(outcome({ ok: true, value: m.value ?? null }));
      } else if (m.t === "fail")
        finish(fail("internal", String(m.error ?? "the program failed").slice(0, 2000)));
    };

    const brokerCall = async (id: unknown, name: unknown, args: unknown) => {
      const seq = ++issued;
      const toolName = typeof name === "string" ? name : String(name);
      const input_sha256 = sha256(`${toolName}\n${canonicalJson(args ?? {})}`);
      const reply = (ok: boolean, payload: { result?: unknown; error?: string }) =>
        send({ t: "result", id, ok, ...payload });
      const deny = async (error: string, category: Category, readOnly = false) => {
        const rec: CallRecord = {
          seq,
          tool: toolName.slice(0, 200),
          status: "denied",
          category,
          ms: 0,
          input_sha256,
          bytes: 0,
          read_only: readOnly,
        };
        calls[seq - 1] = rec;
        await deps.record?.(rec, undefined, error);
        reply(false, { error });
      };
      if (seq > lim.maxCalls)
        return deny(`call budget of ${lim.maxCalls} nested calls reached`, "budget_exceeded");
      if (resultBytes >= lim.maxResultBytes)
        return deny(`result budget of ${lim.maxResultBytes} bytes reached`, "budget_exceeded");
      const tool = deps.tools().find((t) => t.name === name);
      if (!tool) return deny(`unknown tool "${toolName.slice(0, 100)}"`, "invalid_input");
      if (!tool.readOnly)
        return deny(
          `${tool.name} changes external state; CodeAct is read-only`,
          "unauthorized",
          false,
        );

      if (inflight >= lim.maxConcurrency) await new Promise<void>((r) => waiting.push(r));
      inflight++;
      const t0 = Date.now();
      const signal = AbortSignal.any([nested.signal, AbortSignal.timeout(lim.callTimeoutMs)]);
      let r: { ok: boolean; result?: unknown; error?: string };
      try {
        r = await Promise.race([
          deps.call(tool.name, args ?? {}, signal),
          new Promise<never>((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          ),
        ]);
      } catch (e) {
        r = {
          ok: false,
          error: nested.signal.aborted
            ? "canceled"
            : signal.aborted
              ? `${tool.name} exceeded ${lim.callTimeoutMs} ms`
              : (e as Error).message,
        };
      } finally {
        inflight--;
        waiting.shift()?.();
      }
      if (settled) return;
      const timedOut = !r.ok && signal.aborted && !nested.signal.aborted;
      const text = r.ok ? JSON.stringify(r.result ?? null) : undefined;
      const bytes = text ? Buffer.byteLength(text) : 0;
      resultBytes += bytes;
      const overBudget = resultBytes > lim.maxResultBytes;
      const rec: CallRecord = {
        seq,
        tool: tool.name,
        status: r.ok ? (overBudget ? "error" : "ok") : timedOut ? "timeout" : "error",
        ...(overBudget
          ? { category: "budget_exceeded" as const }
          : timedOut
            ? { category: "timeout" as const }
            : {}),
        ms: Date.now() - t0,
        input_sha256,
        ...(text ? { output_sha256: sha256(text) } : {}),
        bytes,
        read_only: true,
      };
      calls[seq - 1] = rec;
      await deps.record?.(rec, r.ok ? r.result : undefined, r.error);
      if (overBudget)
        reply(false, { error: `result budget of ${lim.maxResultBytes} bytes exceeded` });
      else if (r.ok) reply(true, { result: r.result ?? null });
      else reply(false, { error: String(r.error ?? "tool call failed").slice(0, 2000) });
    };

    send({ t: "start", code: req.code });
  });
}
