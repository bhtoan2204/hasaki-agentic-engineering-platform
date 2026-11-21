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
  const fail = (category: Category, error: string) => outcome({ ok: false, category, error });
  const canceled = () => fail("canceled", reasonOf(deps.signal, "execution canceled"));

  if (typeof req.code !== "string" || !req.code.trim())
    return fail("invalid_input", "code is empty");
  if (Buffer.byteLength(req.code) > lim.maxCodeBytes)
    return fail("invalid_input", `code exceeds ${lim.maxCodeBytes} bytes`);
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
  try {
    inv = await (deps.launch ?? testLauncher ?? sandboxLauncher)(process.execPath, nodeArgs);
  } catch (e) {
    return fail(
      e instanceof CodeActError ? e.category : "dependency_unavailable",
      (e as Error).message,
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
      () => finish(fail("timeout", `the program exceeded ${timeoutMs} ms`)),
      timeoutMs,
    );
    const onAbort = () => finish(canceled());
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
    const lineLimit = 2 * lim.maxOutputBytes + 65536;
    child.stdout.on("data", (b: Buffer) => {
      if (settled) return;
      buffer += b.toString();
      let nl: number;
      while (!settled && (nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length > lineLimit)
          return finish(fail("budget_exceeded", "a protocol message exceeded the size limit"));
        if (++messages > lim.maxProtocolMessages)
          return finish(fail("budget_exceeded", "the program sent too many protocol messages"));
        handle(line);
      }
      if (buffer.length > lineLimit)
        finish(fail("budget_exceeded", "a protocol message exceeded the size limit"));
    });

    const violation = (what: string) =>
      finish(fail("invalid_input", `protocol violation: ${what}`));
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
              fail("budget_exceeded", "the program's result exceeded the output limit"),
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
          finish(fail("budget_exceeded", "the program's result exceeded the output limit"));
        else finish(outcome({ ok: true, value: m.value ?? null }));
      } else if (m.t === "fail")
        finish(fail("internal", String(m.error ?? "the program failed").slice(0, 2000)));
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
      const deny = (error: string, category: Category, readOnly = false) => {
        keep(
          {
            seq,
            tool: toolName.slice(0, 200),
            status: "denied",
            category,
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
        return deny(`call budget of ${lim.maxCalls} nested calls reached`, "budget_exceeded");
      if (resultBytes >= lim.maxResultBytes)
        return deny(`result budget of ${lim.maxResultBytes} bytes reached`, "budget_exceeded");
      const tool = deps.tools().find((t) => t.name === name);
      if (!tool) return deny(`unknown tool "${toolName.slice(0, 100)}"`, "invalid_input");
      if (!tool.readOnly)
        return deny(`${tool.name} changes external state; CodeAct is read-only`, "unauthorized");

      const slot = acquire(deadline);
      if (slot === "overflow")
        return deny(
          `too many nested calls at once: ${lim.maxConcurrency} running and ${lim.maxQueuedCalls} queued`,
          "budget_exceeded",
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
        release();
      }
      if (settled) return; // a late completion: discarded, not recorded
      const timedOut = !r.ok && signal.aborted && !nested.signal.aborted;
      const text = r.ok ? (JSON.stringify(r.result ?? null) ?? "null") : undefined;
      const bytes = text ? Buffer.byteLength(text) : 0;
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
            ? { category: "budget_exceeded" as const }
            : timedOut
              ? { category: "timeout" as const }
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
