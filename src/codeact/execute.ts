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
import { codeActEnabled } from "./scope.ts";

export type Category =
  | "unsupported"
  | "unauthorized"
  | "invalid_input"
  | "budget_exceeded"
  | "timeout"
  | "canceled"
  | "dependency_unavailable"
  | "internal";

/**
 * Sanitized diagnosis of a failed execution or nested call: what failed and in which phase, never program text or tool
 * payloads. `Category` above stays the coarse, backward-compatible classification.
 */
export type FailureCategory =
  | "invalid_program"
  | "sandbox_unavailable"
  | "sandbox_startup_failed"
  | "program_syntax_error"
  | "program_runtime_error"
  | "process_terminated"
  | "execution_timeout"
  | "canceled"
  | "resource_budget_exceeded"
  | "ipc_protocol_error"
  | "output_too_large"
  // nested calls
  | "unknown_tool"
  | "unauthorized_tool"
  | "invalid_tool_arguments"
  | "nested_tool_timeout"
  | "tool_output_too_large"
  | "tool_invocation_failed";
export type FailurePhase =
  "validate" | "sandbox_launch" | "sandbox_start" | "program_compile" | "program_run" | "result";
export interface Failure {
  category: FailureCategory;
  phase: FailurePhase;
  /**
   * The most recent nested call that failed before a runtime failure (the program may or may not have failed because of
   * it). `tool` is null when the program asked for a tool that does not exist (its name is program-supplied text).
   */
  last_nested_failure?: { seq: number; tool: string | null; category: FailureCategory };
}

/** What an agent should do about a failure: retry only what a corrected program can fix. */
export function recoveryAdvice(f: Failure): {
  retry: "no" | "fix_program" | "fix_arguments" | "narrow" | "handle_partial_failure";
  hint: string;
} {
  const nested =
    f.category === "program_runtime_error" ? f.last_nested_failure?.category : undefined;
  const narrow = {
    retry: "narrow" as const,
    hint: "Narrow the queries (filters, fewer ids, smaller pages) or return an aggregate instead of raw rows.",
  };
  const no = (hint: string) => ({ retry: "no" as const, hint });
  switch (nested) {
    case "invalid_tool_arguments":
      return {
        retry: "fix_arguments",
        hint: "A nested call had invalid arguments: correct them from the tool's documented arguments, then retry once.",
      };
    case "unknown_tool":
      return {
        retry: "fix_program",
        hint: "A nested call named a tool that does not exist: use an exact name from platform.listTools().",
      };
    case "unauthorized_tool":
      return no(
        "A nested call is not allowed here; retrying cannot change that. Continue without it.",
      );
    case "tool_invocation_failed":
      return {
        retry: "handle_partial_failure",
        hint: "A source failed: do not repeat the same call; wrap it in try/catch and report that source as missing, or answer with the evidence you have.",
      };
    case "nested_tool_timeout":
    case "tool_output_too_large":
    case "resource_budget_exceeded":
      return narrow;
    case "canceled":
      return no("The turn was canceled.");
  }
  switch (f.category) {
    case "invalid_program":
    case "program_syntax_error":
    case "program_runtime_error":
      return { retry: "fix_program", hint: "Fix the program (see `error`) and retry once." };
    case "execution_timeout":
    case "resource_budget_exceeded":
    case "output_too_large":
    case "process_terminated":
      return narrow;
    case "canceled":
      return no("The turn was canceled.");
    default:
      return no(
        "CodeAct cannot run here right now; do not retry it. Use direct tool calls for what is still needed.",
      );
  }
}

/** The nested-call category for a broker outcome reported by a surface's call (coarse `Category` or a denial). */
function nestedFailure(category: Category | undefined, error: string | undefined): FailureCategory {
  switch (category) {
    case "invalid_input":
      return "invalid_tool_arguments";
    case "unauthorized":
      return "unauthorized_tool";
    case "timeout":
      return "nested_tool_timeout";
    case "budget_exceeded":
      return "resource_budget_exceeded";
    case "canceled":
      return "canceled";
  }
  if (/^denied\b/i.test(error ?? "")) return "unauthorized_tool";
  if (/invalid arguments/i.test(error ?? "")) return "invalid_tool_arguments";
  return "tool_invocation_failed";
}

export interface CodeActTool {
  name: string;
  summary: string;
  readOnly: boolean;
}
export type CodeActCall = (
  name: string,
  args: unknown,
  signal: AbortSignal,
) => Promise<{ ok: boolean; result?: unknown; error?: string; category?: Category }>;
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
  /** Sanitized diagnosis of a call that did not succeed. */
  failure?: FailureCategory;
  ms: number;
  input_sha256: string;
  output_sha256?: string;
  bytes: number;
  read_only: boolean;
  /**
   * Whether this call's evidence row was durably recorded: true once the recorder resolved, false when it failed or
   * exceeded `persistTimeoutMs` (with `persist_error`); undefined when no recorder was given (persistence unknown).
   */
  persisted?: boolean;
  persist_error?: string;
}
export interface CodeActResult {
  ok: boolean;
  /** The program's JSON value; when `truncated`, a valid JSON preview of it (never cut JSON text). */
  value?: unknown;
  truncated?: boolean;
  /** Serialized size of the full value when it was too large to return. */
  original_bytes?: number;
  error?: string;
  category?: Category;
  /** Sanitized diagnosis of a failed execution (absent when ok). */
  failure?: Failure;
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
  if (!codeActEnabled()) return "CodeAct is disabled on this installation (codeAct.enabled)";
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

/** The reason an AbortSignal carries, as text (an Error's message, a string, or a default). */
const reasonOf = (signal: AbortSignal | undefined, fallback: string) => {
  const r = signal?.reason as unknown;
  if (r instanceof Error && r.name !== "AbortError") return r.message;
  return typeof r === "string" && r ? r : fallback;
};

/**
 * Run one program. Never throws: every outcome is a CodeActResult with a category.
 *
 * Lifecycle. The caller's signal (workflow attempt, chat turn) is honoured from the first line: before and during the
 * sandbox launch (nothing is spawned when it fires), while the program runs (the process group is killed), and for
 * every nested call (the call's own signal aborts, queued calls are dropped, late results are discarded). The result
 * is produced once, after any in-flight persistence of nested calls has settled.
 *
 * Scheduling. At most `maxConcurrency` nested calls run; up to `maxQueuedCalls` more wait in FIFO order; anything
 * beyond is refused at once. A call's deadline (`callTimeoutMs`) starts when the program issues it, so time spent
 * waiting counts: a call whose deadline passes in the queue never starts.
 *
 * Budgets. Program → parent lines are bounded in size (2 × maxOutputBytes + 64 KiB) and number
 * (`maxProtocolMessages`, malformed lines included); request ids must be fresh positive integers (anything else is a
 * protocol violation that ends the execution); listTools is limited to `maxListTools`. A nested result is serialized
 * once; above `maxCallResultBytes` it is refused, and the delivered total never exceeds `maxResultBytes`.
 */
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
  let phase: FailurePhase = "validate";
  const fail = (
    category: Category,
    error: string,
    failure: FailureCategory,
    at: FailurePhase = phase,
  ) => outcome({ ok: false, category, error, failure: { category: failure, phase: at } });
  const canceled = () => fail("canceled", reasonOf(deps.signal, "execution canceled"), "canceled");

  if (typeof req.code !== "string" || !req.code.trim())
    return fail("invalid_input", "code is empty", "invalid_program");
  if (Buffer.byteLength(req.code) > lim.maxCodeBytes)
    return fail("invalid_input", `code exceeds ${lim.maxCodeBytes} bytes`, "invalid_program");
  if (deps.signal?.aborted) return canceled();
  const timeoutMs = Math.max(100, Math.min(req.timeoutMs ?? lim.timeoutMs, lim.timeoutMs));

  const nodeArgs = [
    "--permission",
    `--allow-fs-read=${RUNNER}`,
    `--max-old-space-size=${Math.max(32, Math.floor(lim.memoryMb * 0.75))}`,
    "--no-warnings",
    RUNNER,
  ];
  let inv: Awaited<ReturnType<Launcher>>;
  phase = "sandbox_launch";
  try {
    inv = await (deps.launch ?? testLauncher ?? sandboxLauncher)(process.execPath, nodeArgs);
  } catch (e) {
    const unavailable = e instanceof CodeActError && e.category === "dependency_unavailable";
    return fail(
      e instanceof CodeActError ? e.category : "dependency_unavailable",
      (e as Error).message,
      unavailable ? "sandbox_unavailable" : "sandbox_startup_failed",
    );
  }
  // Canceled while the sandbox was being prepared: release it and never spawn the program.
  if (deps.signal?.aborted) {
    try {
      inv.cleanup?.();
    } catch {
      /* best effort: a private temp HOME */
    }
    return canceled();
  }

  phase = "sandbox_start";
  const child = spawn(inv.command, inv.args, {
    env: inv.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const nested = new AbortController();
  const records = new Set<Promise<void>>();
  const usedIds = new Set<number>();
  let settled = false;
  let messages = 0;
  let lists = 0;
  let issued = 0;
  let inflight = 0;
  const queue: Array<{ grant: (ok: boolean) => void }> = [];
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
      nested.abort(
        new Error(r.category === "canceled" ? (r.error ?? "canceled") : "execution ended"),
      );
      for (const w of queue.splice(0)) w.grant(false);
      kill();
      try {
        inv.cleanup?.();
      } catch {
        /* best effort: a private temp HOME */
      }
      // Nested-call rows already being written land before the caller finalizes the execution.
      void Promise.allSettled([...records]).then(() => resolve(r));
    };
    const write = (line: string) => {
      if (!settled && child.stdin.writable) child.stdin.write(`${line}\n`);
    };
    const timer = setTimeout(
      () => finish(fail("timeout", `the program exceeded ${timeoutMs} ms`, "execution_timeout")),
      timeoutMs,
    );
    const onAbort = () => finish(canceled());
    deps.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (e) =>
      finish(fail("dependency_unavailable", e.message, "sandbox_startup_failed")),
    );
    child.stdin.on("error", () => {});
    child.stderr.on("data", (b: Buffer) => {
      stderrTail = (stderrTail + b.toString()).slice(-2000);
    });
    child.on("close", (code) =>
      finish(
        fail(
          "internal",
          `the program ended without a result (exit ${code ?? "signal"})${stderrTail.trim() ? `: ${stderrTail.trim().split("\n").slice(-2).join(" | ")}` : ""}`,
          // Nothing from the runner at all: the sandbox never came up. Otherwise the process died while running.
          phase === "sandbox_start" ? "sandbox_startup_failed" : "process_terminated",
        ),
      ),
    );

    let buffer = "";
    const lineLimit = 2 * lim.maxOutputBytes + 65536;
    child.stdout.on("data", (b: Buffer) => {
      if (settled) return;
      buffer += b.toString();
      let nl: number;
      while (!settled && (nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length > lineLimit)
          return finish(
            fail(
              "budget_exceeded",
              "a protocol message exceeded the size limit",
              "resource_budget_exceeded",
            ),
          );
        if (++messages > lim.maxProtocolMessages)
          return finish(
            fail(
              "budget_exceeded",
              "the program sent too many protocol messages",
              "resource_budget_exceeded",
            ),
          );
        handle(line);
      }
      if (buffer.length > lineLimit)
        finish(
          fail(
            "budget_exceeded",
            "a protocol message exceeded the size limit",
            "resource_budget_exceeded",
          ),
        );
    });

    const violation = (what: string) =>
      finish(fail("invalid_input", `protocol violation: ${what}`, "ipc_protocol_error"));
    const freshId = (id: unknown): id is number => {
      if (!Number.isSafeInteger(id) || (id as number) <= 0) {
        violation("request ids must be positive integers");
        return false;
      }
      if (usedIds.has(id as number)) {
        violation(`request id ${id} was already used`);
        return false;
      }
      usedIds.add(id as number);
      return true;
    };

    const handle = (line: string) => {
      let m: {
        t?: string;
        id?: unknown;
        name?: unknown;
        args?: unknown;
        value?: unknown;
        error?: unknown;
        truncated?: unknown;
        original_bytes?: unknown;
      };
      try {
        m = JSON.parse(line);
      } catch {
        return; // not protocol: ignored (but counted)
      }
      if (!m || typeof m !== "object") return;
      // The runner spoke: the sandbox is up and the program is running.
      if (phase === "sandbox_start") phase = "program_run";
      if (m.t === "started") return;
      if (m.t === "list") {
        if (!freshId(m.id)) return;
        if (++lists > lim.maxListTools)
          return write(
            JSON.stringify({
              t: "tools",
              id: m.id,
              error: `listTools is limited to ${lim.maxListTools} calls`,
            }),
          );
        write(
          JSON.stringify({
            t: "tools",
            id: m.id,
            tools: deps
              .tools()
              .filter((t) => t.readOnly)
              .map(({ name, summary }) => ({ name, summary })),
          }),
        );
      } else if (m.t === "call") {
        if (freshId(m.id)) void brokerCall(m.id, m.name, m.args);
      } else if (m.t === "done") {
        const text = JSON.stringify(m.value ?? null);
        if (m.truncated === true) {
          const original = Number(m.original_bytes);
          if (!(original > lim.maxOutputBytes) || Buffer.byteLength(text) > lim.maxOutputBytes)
            return finish(
              fail(
                "budget_exceeded",
                "the program's result exceeded the output limit",
                "output_too_large",
                "result",
              ),
            );
          finish(
            outcome({
              ok: true,
              value: m.value ?? null,
              truncated: true,
              original_bytes: original,
            }),
          );
        } else if (Buffer.byteLength(text) > lim.maxOutputBytes)
          finish(
            fail(
              "budget_exceeded",
              "the program's result exceeded the output limit",
              "output_too_large",
              "result",
            ),
          );
        else finish(outcome({ ok: true, value: m.value ?? null }));
      } else if (m.t === "fail") {
        // The runner is untrusted: only its known phase values are read.
        const compile = (m as { phase?: unknown }).phase === "compile";
        const atResult = (m as { phase?: unknown }).phase === "result";
        const r = fail(
          "internal",
          String(m.error ?? "the program failed").slice(0, 2000),
          compile ? "program_syntax_error" : "program_runtime_error",
          compile ? "program_compile" : atResult ? "result" : "program_run",
        );
        const last = compile
          ? undefined
          : calls.filter((c) => c && c.failure).sort((a, b) => b.seq - a.seq)[0];
        if (last && r.failure)
          r.failure.last_nested_failure = {
            seq: last.seq,
            tool: last.failure === "unknown_tool" ? null : last.tool,
            category: last.failure!,
          };
        finish(r);
      }
    };

    /** A concurrency slot, FIFO; false when the deadline passes in the queue or the execution ends. */
    const acquire = (deadline: number): Promise<boolean> | "overflow" => {
      if (inflight < lim.maxConcurrency) {
        inflight++;
        return Promise.resolve(true);
      }
      if (queue.length >= lim.maxQueuedCalls) return "overflow";
      return new Promise<boolean>((done) => {
        const entry = {
          grant: (ok: boolean) => {
            clearTimeout(expiry);
            done(ok);
          },
        };
        const expiry = setTimeout(
          () => {
            const i = queue.indexOf(entry);
            if (i >= 0) queue.splice(i, 1);
            done(false);
          },
          Math.max(0, deadline - Date.now()),
        );
        queue.push(entry);
      });
    };
    const release = () => {
      const next = queue.shift();
      if (next && !settled)
        next.grant(true); // the slot passes on: inflight unchanged
      else {
        inflight--;
        next?.grant(false);
      }
    };

    const brokerCall = async (id: number, name: unknown, args: unknown) => {
      const seq = ++issued;
      const issuedAt = Date.now();
      const deadline = issuedAt + lim.callTimeoutMs;
      const toolName = typeof name === "string" ? name : String(name);
      const input_sha256 = sha256(`${toolName}\n${canonicalJson(args ?? {})}`);
      const reply = (error: string) => write(JSON.stringify({ t: "result", id, ok: false, error }));
      const keep = (rec: CallRecord, result: unknown, error?: string) => {
        calls[seq - 1] = rec;
        if (!deps.record) return;
        const record = deps.record;
        // The outcome is kept on the record itself, never swallowed: a reference is only emitted for persisted calls.
        let expiry: NodeJS.Timeout | undefined;
        const p = Promise.race([
          Promise.resolve().then(() => record(rec, result, error)),
          new Promise<never>((_, reject) => {
            expiry = setTimeout(
              () =>
                reject(new Error(`evidence recording timed out after ${lim.persistTimeoutMs} ms`)),
              lim.persistTimeoutMs,
            );
          }),
        ])
          .then(
            () => {
              rec.persisted = true;
            },
            (e: unknown) => {
              rec.persisted = false;
              rec.persist_error = String((e as Error)?.message ?? e).slice(0, 500);
            },
          )
          .finally(() => {
            clearTimeout(expiry);
            records.delete(p);
          });
        records.add(p);
      };
      const deny = (
        error: string,
        category: Category,
        failure: FailureCategory,
        readOnly = false,
      ) => {
        keep(
          {
            seq,
            tool: toolName.slice(0, 200),
            status: "denied",
            category,
            failure,
            ms: 0,
            input_sha256,
            bytes: 0,
            read_only: readOnly,
          },
          undefined,
          error,
        );
        reply(error);
      };
      if (seq > lim.maxCalls)
        return deny(
          `call budget of ${lim.maxCalls} nested calls reached`,
          "budget_exceeded",
          "resource_budget_exceeded",
        );
      if (resultBytes >= lim.maxResultBytes)
        return deny(
          `result budget of ${lim.maxResultBytes} bytes reached`,
          "budget_exceeded",
          "resource_budget_exceeded",
        );
      const tool = deps.tools().find((t) => t.name === name);
      if (!tool)
        return deny(`unknown tool "${toolName.slice(0, 100)}"`, "invalid_input", "unknown_tool");
      if (!tool.readOnly)
        return deny(
          `${tool.name} changes external state; CodeAct is read-only`,
          "unauthorized",
          "unauthorized_tool",
        );

      const slot = acquire(deadline);
      if (slot === "overflow")
        return deny(
          `too many nested calls at once: ${lim.maxConcurrency} running and ${lim.maxQueuedCalls} queued`,
          "budget_exceeded",
          "resource_budget_exceeded",
          true,
        );
      const granted = await slot;
      // A slot handed over at (or after) the deadline is not used: the call never starts late.
      if (granted && Date.now() >= deadline) release();
      if (!granted || Date.now() >= deadline) {
        if (settled) return;
        keep(
          {
            seq,
            tool: tool.name,
            status: "timeout",
            category: "timeout",
            failure: "nested_tool_timeout",
            ms: Date.now() - issuedAt,
            input_sha256,
            bytes: 0,
            read_only: true,
          },
          undefined,
          `${tool.name} waited past its ${lim.callTimeoutMs} ms deadline`,
        );
        return reply(`${tool.name} exceeded ${lim.callTimeoutMs} ms (waiting for a free slot)`);
      }
      if (settled) return release();
      const signal = AbortSignal.any([
        nested.signal,
        AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      ]);
      const t0 = Date.now();
      let r: { ok: boolean; result?: unknown; error?: string; category?: Category };
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
        release();
      }
      if (settled) return; // a late completion: discarded, not recorded
      const timedOut = !r.ok && signal.aborted && !nested.signal.aborted;
      const text = r.ok ? (JSON.stringify(r.result ?? null) ?? "null") : undefined;
      const bytes = text ? Buffer.byteLength(text) : 0;
      const tooLarge = !!text && bytes > lim.maxCallResultBytes;
      const refusal = !text
        ? undefined
        : bytes > lim.maxCallResultBytes
          ? `result of ${tool.name} is ${bytes} bytes, above the ${lim.maxCallResultBytes}-byte limit per call: narrow the query`
          : resultBytes + bytes > lim.maxResultBytes
            ? `result budget of ${lim.maxResultBytes} bytes exceeded: narrow the queries`
            : undefined;
      if (text && !refusal) resultBytes += bytes;
      keep(
        {
          seq,
          tool: tool.name,
          status: r.ok ? (refusal ? "error" : "ok") : timedOut ? "timeout" : "error",
          ...(refusal
            ? {
                category: "budget_exceeded" as const,
                failure: tooLarge
                  ? ("tool_output_too_large" as const)
                  : ("resource_budget_exceeded" as const),
              }
            : timedOut
              ? { category: "timeout" as const, failure: "nested_tool_timeout" as const }
              : !r.ok
                ? {
                    ...(r.category ? { category: r.category } : {}),
                    failure: nested.signal.aborted
                      ? ("canceled" as const)
                      : nestedFailure(r.category, r.error),
                  }
                : {}),
          ms: Date.now() - t0,
          input_sha256,
          ...(text ? { output_sha256: sha256(text) } : {}),
          bytes: refusal ? 0 : bytes,
          read_only: true,
        },
        r.ok && !refusal ? r.result : undefined,
        refusal ?? r.error,
      );
      if (refusal) reply(refusal);
      else if (r.ok) write(`{"t":"result","id":${id},"ok":true,"result":${text}}`);
      else reply(String(r.error ?? "tool call failed").slice(0, 2000));
    };

    write(JSON.stringify({ t: "start", code: req.code, maxOutputBytes: lim.maxOutputBytes }));
  });
}
