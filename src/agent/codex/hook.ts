/**
 * Codex hook command (PreToolUse, PermissionRequest, SessionStart). Codex runs it BEFORE the tool executes and passes
 * the call as JSON on stdin (learn.chatgpt.com/docs/hooks). The decision is made by the worker through the per-attempt
 * broker; this process only relays it.
 *
 * Fail closed: if the broker is unreachable, the token is missing, or anything throws, a PreToolUse or PermissionRequest
 * is DENIED (stdout JSON + exit code 2 with the reason on stderr — both documented deny forms).
 */
import { brokerRequest } from "./client.ts";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => (s += c));
    process.stdin.on("end", () => resolve(s));
    process.stdin.on("error", () => resolve(s));
  });
}

function respond(event: string, allow: boolean, reason: string) {
  if (allow) process.exit(0);
  const out =
    event === "PermissionRequest"
      ? {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "deny", message: reason },
          },
        }
      : {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        };
  process.stdout.write(JSON.stringify(out));
  process.stderr.write(`platform policy: ${reason}\n`);
  process.exit(2);
}

async function main() {
  let event = "PreToolUse";
  try {
    const raw = await readStdin();
    const payload = JSON.parse(raw || "{}");
    event = String(payload.hook_event_name ?? event);
    const socket = process.env.PLATFORM_BROKER_SOCKET;
    const token = process.env.PLATFORM_BROKER_TOKEN;
    if (!socket || !token)
      throw new Error("platform broker credentials are missing from the hook environment");
    const r = await brokerRequest(socket, { token, kind: "hook", payload }, 60_000);
    if (!r?.ok) throw new Error(String(r?.error ?? "broker refused the request"));
    respond(
      event,
      r.decision?.allow === true,
      String(r.decision?.reason ?? "denied by platform policy"),
    );
  } catch (e) {
    const gated = event === "PreToolUse" || event === "PermissionRequest";
    if (!gated) process.exit(0);
    respond(
      event,
      false,
      `platform policy unavailable (${(e as Error).message}); the call was not executed`,
    );
  }
}

void main();
