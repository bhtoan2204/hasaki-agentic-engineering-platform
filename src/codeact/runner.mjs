/**
 * CodeAct runner (P1-A, ADR 0008). Runs INSIDE the OS sandbox (src/codeact/execute.ts launches it through
 * sandboxInvocation: no network, no credentials, masked HOME/data/repositories, Node --permission). The real security
 * boundary is that sandbox and the parent broker; the vm context here only gives the program a small, clean API.
 * Nothing here is trusted by the parent: it re-checks every message (the program can reach this process).
 *
 * Protocol (JSON lines).
 *   stdin  ← {t:"start",code,maxOutputBytes} | {t:"result",id,ok,result|error} | {t:"tools",id,tools|error}
 *   stdout → {t:"call",id,name,args} | {t:"list",id} | {t:"done",value[,truncated,original_bytes]} | {t:"fail",error,category?}
 */
import vm from "node:vm";
import { createInterface } from "node:readline";

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const pending = new Map();
let nextId = 0;
let started = false;

const request = (message) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    send({ ...message, id });
  });
const platform = Object.freeze({
  callTool: (name, args) => request({ t: "call", name, args: args ?? {} }),
  listTools: () => request({ t: "list" }),
});
const toText = (args) =>
  args.map((a) => (typeof a === "string" ? a : (JSON.stringify(a) ?? String(a)))).join(" ");
// The program's console goes to stderr (discarded by the parent beyond a small diagnostic tail), never to the protocol.
const programConsole = Object.freeze({
  log: (...a) => process.stderr.write(`${toText(a)}\n`),
  error: (...a) => process.stderr.write(`${toText(a)}\n`),
  warn: (...a) => process.stderr.write(`${toText(a)}\n`),
});

const size = (v) => Buffer.byteLength(JSON.stringify(v) ?? "null");
/**
 * A valid JSON value of at most `budget` bytes that keeps the shape of `v`: strings are cut, arrays keep their first
 * items, objects their first keys (small scalar fields first), each with a marker of what was left out.
 */
function preview(v, budget) {
  if (budget < 8) return null;
  if (typeof v === "string") {
    if (size(v) <= budget) return v;
    let s = v.slice(0, Math.max(0, budget - 40));
    while (s && size(`${s}… (+${v.length - s.length} chars)`) > budget)
      s = s.slice(0, Math.floor(s.length * 0.9));
    return `${s}… (+${v.length - s.length} chars)`;
  }
  if (v === null || typeof v !== "object") return size(v) <= budget ? v : null;
  if (Array.isArray(v)) {
    const out = [];
    let used = 2 + 40;
    for (const item of v) {
      const p = preview(item, Math.min(budget - used, Math.max(64, Math.floor(budget / 4))));
      const cost = size(p) + 1;
      if (p === null || used + cost > budget) break;
      out.push(p);
      used += cost;
    }
    if (out.length < v.length) out.push(`… (+${v.length - out.length} items)`);
    return size(out) <= budget ? out : [];
  }
  const out = {};
  let used = 2 + 60;
  const keys = Object.keys(v).sort((a, b) => size(v[a]) - size(v[b]));
  let kept = 0;
  for (const k of keys) {
    const room = budget - used - size(k) - 2;
    const p = preview(v[k], Math.min(room, Math.max(64, Math.floor(budget / 3))));
    const cost = size(k) + size(p) + 2;
    if (p === null || used + cost > budget) continue;
    out[k] = p;
    used += cost;
    kept++;
  }
  if (kept < keys.length) out["…"] = `${keys.length - kept} more keys`;
  return size(out) <= budget ? out : {};
}

async function start(code, maxOutputBytes) {
  if (started) return;
  started = true;
  let value;
  try {
    const context = vm.createContext({ console: programConsole });
    const program = vm.runInContext(`(async (platform) => {\n${code}\n})`, context, {
      filename: "program.js",
    });
    value = await program(platform);
  } catch (e) {
    send({ t: "fail", error: String(e?.message ?? e).slice(0, 2000) });
    process.exit(0);
  }
  let text;
  try {
    text = JSON.stringify(value === undefined ? null : value);
  } catch (e) {
    send({ t: "fail", error: `the result is not JSON: ${e.message}`, category: "internal" });
    process.exit(0);
  }
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxOutputBytes) process.stdout.write(`{"t":"done","value":${text}}\n`);
  else
    send({
      t: "done",
      truncated: true,
      original_bytes: bytes,
      value: preview(JSON.parse(text), maxOutputBytes),
    });
  process.exit(0);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.t === "start") void start(String(m.code ?? ""), Number(m.maxOutputBytes) || 16000);
  else if (m.t === "result" || m.t === "tools") {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error !== undefined) p.reject(new Error(String(m.error)));
    else p.resolve(m.t === "tools" ? m.tools : m.result);
  }
});
