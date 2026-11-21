/**
 * CodeAct runner (P1-A, ADR 0008). Runs INSIDE the OS sandbox (src/codeact/execute.ts launches it through
 * sandboxInvocation: no network, no credentials, masked HOME/data/repositories, Node --permission). The real security
 * boundary is that sandbox and the parent broker; the vm context here only gives the program a small, clean API.
 *
 * Protocol (JSON lines). stdin ← {t:"start",code} | {t:"result",id,ok,result|error} | {t:"tools",tools}
 *                        stdout → {t:"call",id,name,args} | {t:"list"} | {t:"done",value} | {t:"fail",error,category?}
 */
import vm from "node:vm";
import { createInterface } from "node:readline";

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const pending = new Map();
let nextId = 0;
let toolsWaiter = null;
let started = false;

const platform = Object.freeze({
  callTool: (name, args) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      send({ t: "call", id, name, args: args ?? {} });
    }),
  listTools: () =>
    new Promise((resolve) => {
      toolsWaiter = resolve;
      send({ t: "list" });
    }),
});
const toText = (args) =>
  args.map((a) => (typeof a === "string" ? a : (JSON.stringify(a) ?? String(a)))).join(" ");
// The program's console goes to stderr (discarded by the parent beyond a small diagnostic tail), never to the protocol.
const programConsole = Object.freeze({
  log: (...a) => process.stderr.write(`${toText(a)}\n`),
  error: (...a) => process.stderr.write(`${toText(a)}\n`),
  warn: (...a) => process.stderr.write(`${toText(a)}\n`),
});

async function start(code) {
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
  process.stdout.write(`{"t":"done","value":${text}}\n`);
  process.exit(0);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.t === "start") void start(String(m.code ?? ""));
  else if (m.t === "result") {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(String(m.error ?? "tool call failed")));
  } else if (m.t === "tools" && toolsWaiter) {
    toolsWaiter(m.tools);
    toolsWaiter = null;
  }
});
