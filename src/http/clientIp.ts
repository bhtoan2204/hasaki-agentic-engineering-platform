import type { IncomingMessage } from "node:http";
import { config } from "../config.ts";

/**
 * The client address of a request, for throttling and audit. X-Forwarded-For is client-controlled until a trusted
 * proxy appends to it, so it is used only when TRUSTED_PROXY_HOPS says how many proxies sit in front: the address is
 * then read that many entries from the right of (X-Forwarded-For + socket address), where a spoofed prefix cannot reach.
 * Without trusted proxies (the default) the header is ignored.
 */
export function clientIp(req: IncomingMessage, hops = config.http.trustedProxyHops): string {
  const remote = req.socket.remoteAddress ?? "";
  if (hops <= 0) return remote.slice(0, 80);
  const forwarded = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const chain = [...forwarded, remote].filter(Boolean);
  return (chain[Math.max(0, chain.length - 1 - hops)] ?? "").slice(0, 80);
}
