/**
 * Response compression for what the browser downloads most: the UI bundle and large JSON route results (a run with a
 * few thousand attempts is ~1.5 MB of JSON, ~10x smaller compressed). Compression runs on libuv's thread pool, never on
 * the event loop. Responses below COMPRESS_MIN_BYTES go out as they are (the saving does not pay for the work).
 *
 * Static files are precompressed at build time (scripts/precompress-web.ts); without a sibling they are compressed on
 * first request and kept.
 *
 * Not compressed: SSE streams, artifact downloads, and the session routes (login, /api/auth/me): a response that carries
 * a secret (the CSRF token) is never compressed (BREACH). HTTP_COMPRESSION=off disables it entirely (a proxy in front
 * that already compresses).
 */
import { brotliCompress, constants, gzip } from "node:zlib";
import { promisify } from "node:util";
import { readFileSync, statSync } from "node:fs";

const br = promisify(brotliCompress);
const gz = promisify(gzip);
export const COMPRESS_MIN_BYTES = 8 * 1024;
export type Encoding = "br" | "gzip";

export const compressionEnabled = () => process.env.HTTP_COMPRESSION !== "off";

/** The best encoding the client accepts (`q=0` refuses one), or null. */
export function pickEncoding(accept: string | string[] | undefined): Encoding | null {
  if (!compressionEnabled() || !accept) return null;
  const offered = new Map<string, number>();
  for (const part of String(accept).split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => /^\s*q=([\d.]+)/.exec(p)?.[1]).find(Boolean);
    offered.set(name.trim(), q === undefined ? 1 : Number(q));
  }
  const ok = (name: string) => (offered.get(name) ?? offered.get("*") ?? 0) > 0;
  return ok("br") ? "br" : ok("gzip") ? "gzip" : null;
}

export function compress(body: Buffer, encoding: Encoding): Promise<Buffer> {
  return encoding === "br"
    ? br(body, {
        params: {
          // Quality 4: most of brotli's gain at a gzip-like cost, for responses compressed on every request.
          [constants.BROTLI_PARAM_QUALITY]: 4,
          [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
        },
      })
    : gz(body, { level: 5 });
}

/** Static files are immutable per build (or no-cache and re-read): each is compressed once per encoding and mtime. */
const staticCache = new Map<string, { mtimeMs: number; body: Buffer }>();
export async function compressedStatic(
  file: string,
  mtimeMs: number,
  body: Buffer,
  encoding: Encoding,
): Promise<Buffer> {
  const key = `${encoding}:${file}`;
  const hit = staticCache.get(key);
  if (hit && hit.mtimeMs === mtimeMs) return hit.body;
  // `npm run build` writes <file>.br / <file>.gz (scripts/precompress-web.ts); used while not older than the file.
  const sibling = `${file}.${encoding === "br" ? "br" : "gz"}`;
  try {
    if (statSync(sibling).mtimeMs >= mtimeMs) {
      const pre = readFileSync(sibling);
      staticCache.set(key, { mtimeMs, body: pre });
      return pre;
    }
  } catch {
    /* no precompressed copy: compress below */
  }
  const out = await compress(body, encoding);
  staticCache.set(key, { mtimeMs, body: out });
  return out;
}
