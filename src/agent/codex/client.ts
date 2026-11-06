/** Broker client for the helper processes Codex spawns (hook.ts, bridge.ts). No platform imports: starts fast. */
import { connect } from "node:net";

/** Client side used by hook.ts and bridge.ts: one request, one reply. */
export function brokerRequest(socketPath: string, body: Record<string, unknown>, timeoutMs = 120_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("platform broker timed out"));
    }, timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify(body) + "\n"));
    sock.on("data", (c: string) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        sock.end();
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
        } catch (e) {
          reject(e);
        }
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
