import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

/**
 * Outbound HTTP to a user-supplied endpoint. Every resolved address is checked when the socket connects (so DNS
 * rebinding cannot swap in an internal address after validation), redirects are never followed (credentials are never
 * forwarded), TLS verification stays on, and responses are size-bounded.
 */

export class BlockedDestinationError extends Error {
  readonly code = "blocked_destination";
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata", "instance-data", "metadata.azure.internal"]);
const metadata = new BlockList();
metadata.addAddress("169.254.169.254");
metadata.addAddress("169.254.170.2");
metadata.addAddress("100.100.100.200");
metadata.addAddress("fd00:ec2::254", "ipv6");

const internal = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  internal.addSubnet(net, bits);
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  internal.addSubnet(net, bits, "ipv6");

/** "metadata" is never reachable; "internal" only for an approved host; "public" always. */
export function classifyAddress(address: string): "public" | "internal" | "metadata" {
  const family = isIP(address);
  if (!family) return "internal";
  const mapped = family === 6 && /^::ffff:/i.test(address) ? address.slice(7) : null;
  if (mapped && isIP(mapped) === 4) return classifyAddress(mapped);
  const type = family === 6 ? "ipv6" : "ipv4";
  if (metadata.check(address, type)) return "metadata";
  return internal.check(address, type) ? "internal" : "public";
}

const normalizeHost = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

/** A base URL a user may store: https (http only for an approved internal host), no credentials, no query or fragment. */
export function validateBaseUrl(raw: string, approvedInternalHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BlockedDestinationError("invalid URL");
  }
  const host = normalizeHost(url.hostname);
  const approved = approvedInternalHosts.map(normalizeHost).includes(host);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && approved))
    throw new BlockedDestinationError("only https URLs are allowed (http only for an approved internal host)");
  if (url.username || url.password) throw new BlockedDestinationError("credentials in the URL are not allowed");
  if (url.search || url.hash) throw new BlockedDestinationError("query strings and fragments are not allowed");
  if (METADATA_HOSTS.has(host)) throw new BlockedDestinationError("cloud metadata endpoints are blocked");
  if (isIP(host)) {
    const kind = classifyAddress(host);
    if (kind === "metadata") throw new BlockedDestinationError("cloud metadata endpoints are blocked");
    if (kind === "internal" && !approved)
      throw new BlockedDestinationError(`${host} is an internal address; an administrator must approve it`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

function guardedLookup(host: string, approved: boolean) {
  return (
    hostname: string,
    options: LookupOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      for (const a of addresses) {
        const kind = classifyAddress(a.address);
        if (kind === "metadata" || (kind === "internal" && !approved))
          return callback(
            new BlockedDestinationError(
              `${host} resolves to ${kind === "metadata" ? "a cloud metadata" : "an internal"} address`,
            ) as NodeJS.ErrnoException,
            [],
          );
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

export interface SafeRequest {
  url: URL;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers: Record<string, string>;
  body?: string;
  approvedInternalHosts: string[];
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}

function once(req: SafeRequest): Promise<{ status: number; text: string }> {
  const host = normalizeHost(req.url.hostname);
  const approved = req.approvedInternalHosts.map(normalizeHost).includes(host);
  const transport = req.url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const r = transport.request(
      req.url,
      {
        method: req.method,
        headers: { ...req.headers, ...(req.body ? { "content-length": Buffer.byteLength(req.body) } : {}) },
        lookup: guardedLookup(host, approved),
        timeout: req.timeoutMs,
        signal: req.signal,
        rejectUnauthorized: true,
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return reject(new HttpError(status, "redirects are not followed"));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > req.maxBytes) {
            res.destroy();
            reject(new Error(`response exceeded ${req.maxBytes} bytes; narrow the query`));
          } else chunks.push(c);
        });
        res.on("end", () => resolve({ status, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    r.on("timeout", () => r.destroy(new Error(`request timed out after ${req.timeoutMs} ms`)));
    r.on("error", reject);
    r.end(req.body);
  });
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done, fail) => {
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), fail(signal.reason)), { once: true });
  });

/** One request with bounded retries on network errors, 429 and 5xx. Never retries a blocked destination or abort. */
export async function safeRequest(req: SafeRequest, maxRetries: number) {
  validateBaseUrl(req.url.origin, req.approvedInternalHosts);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await once(req);
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await sleep(200 * 2 ** attempt + Math.random() * 100, req.signal);
        continue;
      }
      return res;
    } catch (e) {
      const retryable =
        !(e instanceof BlockedDestinationError) && !(e instanceof HttpError) && !req.signal?.aborted;
      if (!retryable || attempt >= maxRetries) throw e;
      await sleep(200 * 2 ** attempt + Math.random() * 100, req.signal);
    }
  }
}

const buckets = new Map<string, { tokens: number; at: number }>();
/** Token bucket per key (e.g. user): `perSecond` sustained, `burst` at once. Waits instead of failing. */
export async function rateLimit(key: string, perSecond = 5, burst = 10) {
  for (;;) {
    const now = Date.now();
    const b = buckets.get(key) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSecond);
    b.at = now;
    buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return;
    }
    await sleep(Math.ceil(((1 - b.tokens) / perSecond) * 1000));
  }
}
