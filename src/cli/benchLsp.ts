/**
 * LSP vs syntax navigation (P1-B, ADR 0009), no database: a Go module with two `Process` functions in different
 * packages (one imported under an alias) and their callers. Syntax = the Tree-sitter extractor the index uses
 * (`extract`): name-matched definitions and call relations. LSP = gopls through the platform's session pool
 * (sandboxed when the host has the OS sandbox). Reports correct/false-positive counts, cold and warm latency, RSS.
 *
 *   node --disable-warning=ExperimentalWarning src/cli/benchLsp.ts [--runs 10]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "../config.ts";
import { extract } from "../codeIntelligence/parser.ts";
import { closeAllSessions, getSession } from "../codeIntelligence/lsp/sessions.ts";
import { workspaceFingerprint } from "../codeIntelligence/lsp/navigate.ts";
import { probeIsolation } from "../agent/isolation.ts";
import type { Location } from "../codeIntelligence/lsp/client.ts";

const runs = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 10;
const FILES: Record<string, string> = {
  "go.mod": "module example.com/bench\n\ngo 1.22\n",
  "payment/process.go": "package payment\n\nfunc Process(id string) string { return id }\n",
  "refund/process.go": "package refund\n\nfunc Process(id string) string { return id }\n",
  "refund/use.go":
    "package refund\n\nfunc Twice(id string) string { return Process(id) + Process(id) }\n",
  "main.go":
    'package main\n\nimport (\n\tpay "example.com/bench/payment"\n\t"example.com/bench/refund"\n)\n\nfunc main() {\n\t_ = pay.Process("a")\n\t_ = refund.Process("b")\n\t_ = pay.Process("c")\n}\n',
};
const root = realpathSync(mkdtempSync(join(tmpdir(), "bench-lsp-")));
for (const [p, body] of Object.entries(FILES)) {
  mkdirSync(join(root, p, ".."), { recursive: true });
  writeFileSync(join(root, p), body);
}
execFileSync("git", ["-C", root, "init", "-q"]);
execFileSync("git", ["-C", root, "add", "."]);
execFileSync("git", [
  "-C",
  root,
  "-c",
  "user.name=b",
  "-c",
  "user.email=b@b",
  "commit",
  "-qm",
  "f",
]);
if (!(await probeIsolation(true)).available) config.lsp.allowUnsandboxed = true;

// Truth: pay.Process (main.go:9) is defined at payment/process.go:3; payment.Process is called on main.go:9 and :11.
const TRUTH_DEF = "payment/process.go:3";
const TRUTH_REFS = ["main.go:11", "main.go:9", "payment/process.go:3"];

// Syntax: every declaration named Process is a definition candidate; every call relation to Process is a reference.
const t0 = performance.now();
const syntaxDefs: string[] = [];
const syntaxRefs: string[] = [];
for (const p of Object.keys(FILES).filter((f) => f.endsWith(".go"))) {
  const x = await extract(p, FILES[p]);
  for (const s of x?.symbols ?? [])
    if (s.symbol_name === "Process") syntaxDefs.push(`${p}:${s.start_line}`);
  for (const r of x?.relations ?? [])
    if (r.target_name.split(".").at(-1) === "Process") syntaxRefs.push(`${p}:${r.line}`);
}
const syntaxMs = performance.now() - t0;

const uri = pathToFileURL(join(root, "main.go")).href;
const at = { textDocument: { uri }, position: { line: 8, character: 9 } }; // pay.Process on line 9
const toKey = (l: Location) => `${relative(root, fileURLToPath(l.uri))}:${l.range.start.line + 1}`;
const timing = { timeoutMs: config.lsp.requestTimeoutMs };
const coldStart = performance.now();
const { fingerprint } = await workspaceFingerprint(root);
const client = await getSession("go", root, fingerprint);
client.sync(uri, "go", readFileSync(join(root, "main.go"), "utf8"));
const def = (await client.request<Location[]>("textDocument/definition", at, timing)) ?? [];
const coldMs = performance.now() - coldStart;
const warm: number[] = [];
let refs: Location[] = [];
for (let i = 0; i < runs; i++) {
  const s = performance.now();
  refs =
    (await client.request<Location[]>(
      "textDocument/references",
      { ...at, context: { includeDeclaration: true } },
      timing,
    )) ?? [];
  warm.push(performance.now() - s);
}
warm.sort((a, b) => a - b);
// Resident memory of the server and every descendant (bwrap starts a new session, so walk parent links).
let rssMb: number | null = null;
try {
  const rows = execFileSync("ps", ["-e", "-o", "pid=,ppid=,rss="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number));
  const tree = new Set([client.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of rows)
      if (tree.has(ppid) && !tree.has(pid)) {
        tree.add(pid);
        grew = true;
      }
  }
  rssMb = rows.filter(([pid]) => tree.has(pid)).reduce((a, [, , rss]) => a + rss / 1024, 0);
} catch {
  rssMb = null;
}
await closeAllSessions();

const lspDefs = def.map(toKey);
const lspRefs = refs.map(toKey).sort();
const score = (got: string[], truth: string[]) => ({
  correct: got.filter((g) => truth.includes(g)).length,
  false_positives: got.filter((g) => !truth.includes(g)).length,
  missed: truth.filter((t) => !got.includes(t)).length,
});
console.log(
  JSON.stringify(
    {
      fixture: "two Go functions named Process, one imported under an alias",
      definition: {
        syntax: { candidates: syntaxDefs, ...score(syntaxDefs, [TRUTH_DEF]) },
        lsp: { result: lspDefs, ...score(lspDefs, [TRUTH_DEF]) },
      },
      references: {
        syntax: { candidates: syntaxRefs.sort(), ...score(syntaxRefs, TRUTH_REFS) },
        lsp: { result: lspRefs, ...score(lspRefs, TRUTH_REFS) },
      },
      latency_ms: {
        syntax_extract_all_files: Math.round(syntaxMs),
        lsp_cold_start_plus_definition: Math.round(coldMs),
        lsp_warm_references_p50: Math.round(warm[Math.floor(warm.length / 2)]),
        lsp_warm_references_max: Math.round(warm.at(-1)!),
      },
      lsp_server_rss_mb: rssMb && Math.round(rssMb),
      sandboxed: !config.lsp.allowUnsandboxed,
    },
    null,
    2,
  ),
);
