/**
 * Antigravity PreToolUse lifecycle hook command.
 * Invoked before tools execute. Relays tool decision to the worker's per-attempt broker.
 * Fails closed (deny) if broker is unreachable or denies the call.
 */
import { brokerRequest } from "../codex/client.ts";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => (s += c));
    process.stdin.on("end", () => resolve(s));
    process.stdin.on("error", () => resolve(s));
  });
}

function respond(allow: boolean, reason: string) {
  const out = allow
    ? { decision: "allow" }
    : { decision: "deny", reason: `platform policy: ${reason}` };
  process.stdout.write(JSON.stringify(out));
  if (!allow) {
    process.stderr.write(`platform policy: ${reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

async function main() {
  try {
    const raw = await readStdin();
    const payload = JSON.parse(raw || "{}");
    const socket = process.env.PLATFORM_BROKER_SOCKET;
    const token = process.env.PLATFORM_BROKER_TOKEN;
    if (!socket || !token)
      throw new Error("platform broker credentials are missing from the hook environment");

    const r = await brokerRequest(socket, { token, kind: "hook", payload }, 60_000);
    if (!r?.ok) throw new Error(String(r?.error ?? "broker refused the request"));
    respond(r.decision?.allow === true, String(r.decision?.reason ?? "denied by platform policy"));
  } catch (e) {
    respond(
      false,
      `platform policy unavailable (${(e as Error).message}); the call was not executed`,
    );
  }
}

void main();
