/**
 * Shared measurement harness of the engine benchmarks (bench:code-search, bench:knowledge-import). Install it before
 * importing src/config.ts: it points DATABASE_URL at a proxy in front of the isolated test PostgreSQL that counts
 * statements ('Q' simple query, 'E' execute — Node and platform-go alike) and delays every packet by `latencyMs` each
 * way, and puts wrappers for the given tools on PATH that count their processes.
 */
import { connect, createServer as tcpServer, type Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../../src/config.ts";

export async function installBenchHarness(opts: { tools: string[]; latencyMs: number }) {
  if (config.test.platformTest !== "1")
    throw new Error("Use --import ./test/setup.ts with the isolated local test database");
  const scratch = process.env.TEST_ROOT!;
  const wrapDir = join(scratch, "bench-wrappers");
  const counterDir = join(scratch, "bench-counters");
  mkdirSync(wrapDir, { recursive: true });
  mkdirSync(counterDir, { recursive: true });
  for (const tool of opts.tools) {
    const real = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
    writeFileSync(
      join(wrapDir, tool),
      `#!/bin/sh\nprintf . >> ${counterDir}/${tool}\nexec ${real} "$@"\n`,
    );
    chmodSync(join(wrapDir, tool), 0o755);
  }
  process.env.PATH = `${wrapDir}:${config.system.path}`;
  config.system.path = `${wrapDir}:${config.system.path}`;
  const count = (tool: string) => {
    try {
      return readFileSync(join(counterDir, tool), "utf8").length;
    } catch {
      return 0;
    }
  };

  /** `byText`: statements per SQL text (the last Parse of the connection, or the simple query), for a breakdown. */
  const db = { statements: 0, byText: new Map<string, number>() };
  const pipe = (from: Socket, to: Socket, counting: boolean) => {
    let tail = Promise.resolve();
    let buf = Buffer.alloc(0);
    let startup = counting;
    let parsed = "";
    from.on("data", (chunk: Buffer) => {
      if (counting) {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (startup) {
            if (buf.length < 4) break;
            const len = buf.readInt32BE(0);
            if (buf.length < len) break;
            buf = buf.subarray(len);
            startup = len === 8;
            continue;
          }
          if (buf.length < 5) break;
          const len = buf.readInt32BE(1);
          if (buf.length < len + 1) break;
          if (buf[0] === 0x50) {
            // Parse: statement name (cstring), then the query text (cstring).
            const nameEnd = buf.indexOf(0, 5);
            parsed = buf.toString("utf8", nameEnd + 1, buf.indexOf(0, nameEnd + 1));
          }
          if (buf[0] === 0x51 || buf[0] === 0x45) {
            db.statements++;
            const text = (buf[0] === 0x51 ? buf.toString("utf8", 5, len) : parsed)
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 160);
            db.byText.set(text, (db.byText.get(text) ?? 0) + 1);
          }
          buf = buf.subarray(len + 1);
        }
      }
      // Without injected latency, forward at once: a 0 ms timer per packet still costs ~1 ms each way and inflated
      // every local measurement (≈ 2 s of a 1,000-statement workflow run).
      if (!opts.latencyMs) {
        to.write(chunk);
        return;
      }
      const due = Date.now() + opts.latencyMs;
      tail = tail.then(
        () =>
          new Promise<void>((r) =>
            setTimeout(() => (to.write(chunk), r()), Math.max(0, due - Date.now())),
          ),
      );
    });
    from.on("close", () => void tail.then(() => to.destroy()));
    from.on("error", () => to.destroy());
  };
  const directUrl = process.env.DATABASE_URL!;
  const url = new URL(directUrl);
  const socketPath = `${url.searchParams.get("host")}/.s.PGSQL.5432`;
  const server = tcpServer((client) => {
    const upstream = connect({ path: socketPath });
    pipe(client, upstream, true);
    pipe(upstream, client, false);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url.searchParams.delete("host");
  url.host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.DATABASE_URL = url.toString();
  /** directUrl bypasses the proxy: a benchmark's own observation queries are neither counted nor delayed. */
  return { db, count, directUrl };
}

export const quantile = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)];
export const round = (x: number) => Math.round(x * 10) / 10;

/** Bytes a process read through read(2)-like calls (/proc/<pid>/io rchar: page cache included, sockets too). */
export const readChars = (pid: number) => {
  try {
    return Number(/rchar: (\d+)/.exec(readFileSync(`/proc/${pid}/io`, "utf8"))?.[1] ?? 0);
  } catch {
    return 0;
  }
};

/** CPU milliseconds (user + system) and peak RSS (MiB) of another process. */
export const processStat = (pid: number) => {
  const s = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
  return {
    cpu: ((Number(s[11]) + Number(s[12])) * 1000) / 100,
    hwm:
      Number(/VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0) / 1024,
  };
};
