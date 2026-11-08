import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision, PolicyContext } from "../toolPolicy.ts";
import { codexHookDecision, type CodexHookPayload } from "./policy.ts";

/**
 * Per-attempt broker between the Codex process tree and the worker.
 *
 * Codex spawns two kinds of helpers: the PreToolUse/PermissionRequest hook (hook.ts) and the platform MCP server
 * (bridge.ts). Both connect here over a Unix socket in a fresh 0700 temp directory and authenticate with a random
 * per-attempt token. Platform tool calls run in the worker through dispatchPlatformTool (attempt lease, fencing,
 * ownership, open-question checks), so the helpers never receive DATABASE_URL, AUTH_SECRET or other credentials.
 *
 * Protocol: one JSON object per line in each direction.
 *   → {token, kind: "hook", payload}          ← {ok: true, decision: {allow, reason?}}
 *   → {token, kind: "tool", name, args}       ← {ok: true, text}
 */

export interface BrokerDeps {
  policy: PolicyContext;
  cwd: string;
  /** Cursor shares the authenticated worker transport without Codex-specific hook requirements. */
  requireHooks?: boolean;
  /** Platform tool dispatch, bound to the attempt (envFromExecution). */
  dispatch(name: string, args: unknown): Promise<string>;
  onDenied?(tool: string, reason: string): void | Promise<void>;
  /** Hook payloads carry the active model slug; JSONL events do not. */
  onModel?(model: string): void;
}

export interface Broker {
  socketPath: string;
  token: string;
  /** Hook invocations seen (any event). Zero means Codex is not running the platform hooks. */
  readonly hookCalls: number;
  /** Tool names the hook allowed, in order. Used to detect a tool item that never went through the hook. */
  readonly allowedTools: string[];
  close(): Promise<void>;
}

const CODING_ONLY = new Set(["prepare_branch", "commit_changes"]);

export async function startBroker(deps: BrokerDeps): Promise<Broker> {
  const dir = mkdtempSync(join(tmpdir(), "ctp-codex-"));
  chmodSync(dir, 0o700);
  const socketPath = join(dir, "b.sock");
  const token = randomBytes(32).toString("hex");
  const tokenBuf = Buffer.from(token);
  let hookCalls = 0;
  const allowedTools: string[] = [];
  const sockets = new Set<Socket>();

  const authorized = (t: unknown) => {
    if (typeof t !== "string") return false;
    const b = Buffer.from(t);
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  };

  const handle = async (msg: any): Promise<unknown> => {
    if (!msg || !authorized(msg.token)) return { ok: false, error: "unauthorized" };
    if (msg.kind === "hook") {
      hookCalls++;
      const payload = (msg.payload ?? {}) as CodexHookPayload;
      if (typeof payload.model === "string" && payload.model) deps.onModel?.(payload.model);
      let decision: Decision;
      try {
        decision = codexHookDecision(payload, deps.policy, deps.cwd);
      } catch (e) {
        decision = { allow: false, reason: `policy check failed: ${(e as Error).message}` };
      }
      const tool = String(payload.tool_name ?? payload.hook_event_name ?? "");
      if (decision.allow) {
        if (payload.hook_event_name === "PreToolUse") allowedTools.push(tool);
      } else await deps.onDenied?.(tool, decision.reason);
      return { ok: true, decision };
    }
    if (msg.kind === "tool") {
      const name = String(msg.name ?? "");
      if (deps.requireHooks !== false && hookCalls === 0) return { ok: true, text: "ERROR: refused: the platform's pre-execution hooks are not active in this Codex session" };
      if (CODING_ONLY.has(name) && deps.policy.mode !== "coding") return { ok: true, text: `ERROR: ${name} is only available in coding steps` };
      return { ok: true, text: await deps.dispatch(name, msg.args ?? {}) };
    }
    return { ok: false, error: "unknown request" };
  };

  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > 8 * 1024 * 1024) return sock.destroy();
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          sock.write(JSON.stringify({ ok: false, error: "bad json" }) + "\n");
          continue;
        }
        handle(msg)
          .catch((e) => ({ ok: false, error: (e as Error).message }))
          .then((r) => {
            if (!sock.destroyed) sock.write(JSON.stringify(r) + "\n");
          });
      }
    });
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(socketPath, () => res());
  });
  chmodSync(socketPath, 0o600);

  return {
    socketPath,
    token,
    get hookCalls() {
      return hookCalls;
    },
    allowedTools,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((res) => server.close(() => res()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
