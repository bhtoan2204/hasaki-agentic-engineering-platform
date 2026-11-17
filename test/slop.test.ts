import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, type SlopSettings } from "../src/config.ts";
import { ParserLoadError, withTree } from "../src/codeIntelligence/parser.ts";
import { DETECTOR_VERSION, RULES, UNSUPPORTED_RULES, detect, duplicates } from "../src/slop/detectors.ts";
import { compare, fingerprint, type RawFinding } from "../src/slop/findings.ts";
import { activeRules, blocking, effectiveLevel, mergeSlopSettings, validateSlopLayer } from "../src/slop/policy.ts";
import { scanWorkspace } from "../src/slop/scan.ts";
import {
  repairPrompt,
  verificationLoop,
  verificationSummary,
  verifyWorkspaces,
  type SlopVerification,
  type VerifyConfig,
  type VerifyDeps,
} from "../src/agent/verify.ts";

const ALL = { rules: new Set(Object.keys(RULES)), thresholds: config.slop.thresholds };
const settings = (o: Partial<SlopSettings> = {}): SlopSettings => ({ ...config.slop, ...o });
const LANG: Record<string, string> = { ts: "typescript", tsx: "tsx", js: "javascript", jsx: "javascript", go: "go" };
async function run(path: string, source: string, opts = ALL) {
  const language = LANG[path.split(".").pop()!];
  return withTree(language, source, undefined, (root, deadline) => detect(language, path, root, opts, deadline));
}
const rules = (r: { findings: RawFinding[] }) => r.findings.map((f) => `${f.rule}:${f.line}:${f.severity}`);
const branchy = (n: number, name = "busy") =>
  `function ${name}(x) {\n${Array.from({ length: n }, (_, i) => `  if (x === ${i}) return ${i};`).join("\n")}\n  return -1;\n}\n`;

// ---------------------------------------------------------------- detection
test("TS/JS/JSX: empty catch, code after return, placeholder throw, with rule, line, symbol and snippet", async () => {
  for (const path of ["a.ts", "a.js", "a.jsx", "a.tsx"]) {
    const r = await run(
      path,
      `export class Pay {\n  charge() {\n    try { send(); } catch (e) {}\n    return 1;\n    log("never");\n  }\n}\nconst refund = () => {\n  throw new Error("not implemented");\n};\n`,
    );
    const empty = r.findings.find((f) => f.rule === "silent-error")!;
    assert.deepEqual([empty.line, empty.symbol, empty.severity, empty.kind, empty.snippet], [3, "Pay.charge", "high", "deterministic", "catch (e) {}"], path);
    const dead = r.findings.find((f) => f.rule === "unreachable-code")!;
    assert.deepEqual([dead.line, dead.symbol, dead.snippet], [5, "Pay.charge", 'log("never");'], path);
    const stub = r.findings.find((f) => f.rule === "placeholder")!;
    assert.deepEqual([stub.line, stub.symbol, stub.severity], [9, "refund", "high"], path);
    assert.match(stub.snippet, /not implemented/);
  }
});

test("Go: empty err branch, code after return/panic, panic placeholder", async () => {
  const r = await run(
    "svc/pay.go",
    `package pay\n\nfunc (s *Svc) Charge() error {\n\tif err != nil {}\n\tif err != nil {\n\t\t// retried by the caller\n\t}\n\treturn nil\n\ts.log()\n}\n\nfunc Refund() {\n\tpanic("not implemented")\n\tcleanup()\n}\n`,
  );
  assert.deepEqual(rules(r).sort(), [
    "placeholder:13:high",
    "silent-error:4:high",
    "silent-error:5:low",
    "unreachable-code:14:high",
    "unreachable-code:9:high",
  ]);
  assert.equal(r.findings.find((f) => f.line === 9)!.symbol, "pay.Svc.Charge");
  assert.equal(r.findings.find((f) => f.line === 13)!.symbol, "pay.Refund");
});

test("complexity: medium above the threshold, high above the high threshold, value is the cyclomatic number", async () => {
  const medium = (await run("c.js", branchy(16))).findings.find((f) => f.rule === "complexity")!;
  assert.deepEqual([medium.severity, medium.value, medium.symbol, medium.kind], ["medium", 17, "busy", "heuristic"]);
  const high = (await run("c.ts", branchy(30))).findings.find((f) => f.rule === "complexity")!;
  assert.equal(high.severity, "high");
  const goSrc = `package x\nfunc Busy(x int) int {\n${Array.from({ length: 16 }, (_, i) => `\tif x == ${i} { return ${i} }`).join("\n")}\n\treturn 0\n}\n`;
  assert.equal((await run("c.go", goSrc)).findings.find((f) => f.rule === "complexity")?.value, 17);
});

test("duplicate-block: structurally identical functions (renamed) across files; the later one is reported", async () => {
  const body = (name: string, v: string) =>
    `function ${name}(${v}) {\n${Array.from({ length: 12 }, (_, i) => `  ${v} = ${v} + ${i};`).join("\n")}\n  return ${v};\n}\n`;
  const a = await run("a.ts", body("total", "a"));
  const b = await run("b.ts", body("sum", "b"));
  const found = duplicates([...a.shapes, ...b.shapes]);
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].rule, found[0].path, found[0].symbol], ["duplicate-block", "b.ts", "sum"]);
  assert.match(found[0].message, /total \(a\.ts:1\)/);
});

test("test-quality and verbosity rules only where they apply", async () => {
  const js = await run(
    "pay.test.js",
    `it("adds", () => { expect(true).toBe(true); });\nit("does nothing", () => { pay(); });\n// const old = pay();\n// return old;\n// TODO: cover refunds\n`,
  );
  assert.deepEqual(rules(js).sort(), [
    "commented-out-code:3:low",
    "meaningless-assertion:1:medium",
    "placeholder:5:low",
    "test-without-assertion:2:medium",
  ]);
  const go = await run("pay_test.go", `package pay\nfunc TestA(t *testing.T) { assert.Equal(t, 1, 1) }\nfunc TestB(t *testing.T) { Charge() }\nfunc TestC(t *testing.T) { check(t, Charge()) }\n`);
  assert.deepEqual(rules(go).sort(), ["meaningless-assertion:2:medium", "test-without-assertion:3:medium"]);
  // Same calls outside a test file are not test findings.
  assert.deepEqual(rules(await run("pay.js", `it("x", () => { pay(); });\n`)), []);
});

// ---------------------------------------------------------------- false positives
test("false positives: commented catch is low, return inside if, switch fallthrough, short && chains, TODO in a string", async () => {
  const r = await run(
    "f.ts",
    `function f(x) {\n  try { a(); } catch {\n    // best effort: telemetry only\n  }\n  if (x) { return 1; }\n  next();\n  switch (x) {\n    case 1:\n    case 2: g(); break;\n    default: h();\n  }\n  const label = "TODO: not implemented";\n  return x && x.a && x.b && x.c && x.d;\n}\n`,
  );
  assert.deepEqual(rules(r), ["silent-error:2:low"]);
  const short = (n: string) => `function ${n}(a) {\n${Array.from({ length: 5 }, (_, i) => `  a = a + ${i};`).join("\n")}\n  return a;\n}\n`;
  const small = [...(await run("a.ts", short("x"))).shapes, ...(await run("b.ts", short("y"))).shapes];
  assert.deepEqual(duplicates(small), []);
});

// ---------------------------------------------------------------- fingerprint and baseline
test("fingerprint ignores lines moving, changes with the evidence", async () => {
  const src = `function f() {\n  try { a(); } catch (e) {}\n}\n`;
  const [a] = fingerprint((await run("a.ts", src)).findings);
  const [moved] = fingerprint((await run("a.ts", `// header\n\nimport x from "y";\n${src}`)).findings.filter((f) => f.rule === "silent-error"));
  assert.notEqual(a.line, moved.line);
  assert.equal(a.fingerprint, moved.fingerprint);
  const [changed] = fingerprint((await run("a.ts", src.replace("a()", "b()"))).findings);
  assert.equal(a.fingerprint, changed.fingerprint, "snippet is the catch clause, unaffected by the try body");
  const [other] = fingerprint((await run("a.ts", src.replace("catch (e)", "catch (err)"))).findings);
  assert.notEqual(a.fingerprint, other.fingerprint);
});

test("baseline: existing, new, resolved, worsened and suppressed", () => {
  const f = (rule: string, snippet: string, extra: Partial<RawFinding> = {}): RawFinding => ({
    rule, category: "c", severity: "high", confidence: 0.9, kind: "deterministic", path: "a.ts", line: 1, symbol: "s", snippet, message: "", ...extra,
  });
  const base = [f("silent-error", "A"), f("placeholder", "C"), f("complexity", "x", { value: 16, severity: "medium" })];
  const head = [f("silent-error", "A", { line: 9 }), f("unreachable-code", "B"), f("complexity", "y", { value: 21, severity: "medium" }), f("placeholder", "S")];
  const suppressed = fingerprint([head[3]])[0].fingerprint;
  const out = compare(base, head, new Set([suppressed]));
  assert.deepEqual(
    out.map((x) => `${x.rule}:${x.status}`),
    ["silent-error:existing", "unreachable-code:new", "complexity:worsened", "placeholder:suppressed", "placeholder:resolved"],
  );
  assert.equal(out[2].base_value, 16);
});

// ---------------------------------------------------------------- policy
test("policy: repository overrides global overrides config; suppressions accumulate", () => {
  const sup = (c: string) => ({ fingerprint: c.repeat(64), reason: "known" });
  const s = mergeSlopSettings(
    config.slop,
    {
      global: { mode: "enforcement", thresholds: { ...config.slop.thresholds, cyclomatic: 30 }, suppressions: [sup("a")] },
      repositories: { svc: { mode: "disabled", languages: { go: false }, suppressions: [sup("b")] } },
    },
    "svc",
  );
  assert.deepEqual([s.mode, s.thresholds.cyclomatic, s.languages.go, s.languages.typescript], ["disabled", 30, false, true]);
  assert.deepEqual(s.suppressions.map((x) => x.fingerprint[0]), ["a", "b"]);
  assert.equal(mergeSlopSettings(config.slop, null, "svc").mode, "advisory", "default is advisory");
  assert.throws(() => validateSlopLayer({ mode: "strict" }), /mode/);
  assert.throws(() => validateSlopLayer({ rules: { "no-such-rule": false } }), /unknown key/);
  assert.throws(() => validateSlopLayer({ suppressions: [{ fingerprint: "abc", reason: "x" }] }), /fingerprint/);
  assert.deepEqual(validateSlopLayer({ minConfidence: 0.5, rules: { complexity: false } }), { minConfidence: 0.5, rules: { complexity: false } });
});

test("policy: blocking only under enforcement for new/worsened at severity and confidence; levels", () => {
  const f = (status: string, severity: string, confidence: number) => ({ status, severity, confidence, fingerprint: status + severity + confidence });
  const report = { findings: [f("new", "high", 0.95), f("worsened", "high", 0.9), f("existing", "high", 0.95), f("new", "medium", 0.95), f("new", "high", 0.6), f("suppressed", "high", 0.95)] } as never;
  assert.deepEqual(blocking(report, settings()), []);
  assert.deepEqual(blocking(report, settings({ mode: "enforcement" })).map((x) => x.status), ["new", "worsened"]);
  const small = { files: 2, lines: 40 };
  assert.equal(effectiveLevel(settings(), "FAST", small), "micro");
  assert.equal(effectiveLevel(settings(), "MICRO", { files: 50, lines: 5000 }), "micro");
  assert.equal(effectiveLevel(settings(), "FAST", { files: 4, lines: 40 }), "standard");
  assert.equal(effectiveLevel(settings(), "STANDARD", small), "standard");
  assert.equal(effectiveLevel(settings({ level: "standard" }), "FAST", small), "standard");
  assert.deepEqual([...activeRules(settings({ rules: { placeholder: false } }), "micro")], ["unreachable-code", "silent-error"]);
});

// ---------------------------------------------------------------- incremental scan (temporary git repository)
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "slop-scan-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { encoding: "utf8" });
  const write = (p: string, s: string) => {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), s);
  };
  g("init", "-q", "-b", "main");
  write("src/pay.ts", `export function pay() {\n  try { a(); } catch (e) {}\n}\n`);
  write("src/untouched.ts", `export function old() {\n  try { a(); } catch (e) {}\n}\n`);
  write("svc/a.go", `package svc\nfunc A() {}\n`);
  g("add", ".");
  g("commit", "-qm", "base");
  g("checkout", "-qb", "feature");
  return { dir, g, write };
}

test("scan: only eligible changed files, both sides, existing vs new; vendor/generated/excluded skipped; no model", async () => {
  const { dir, g, write } = repo();
  try {
    write("src/pay.ts", `// moved down\nexport function pay() {\n  try { a(); } catch (e) {}\n  return 1;\n  b();\n}\n`);
    write("vendor/x.go", `package x\nfunc X() { panic("not implemented") }\n`);
    write("generated/y.ts", `throw new Error("not implemented");\n`);
    write("svc/a.pb.go", `package svc\nfunc P() { panic("not implemented") }\n`);
    write("legacy/z.ts", `throw new Error("not implemented");\n`);
    write("svc/a.go", `package svc\nfunc A() {\n\tpanic("not implemented")\n}\n`);
    g("add", ".");
    g("commit", "-qm", "change");
    write("src/new.js", `export const k = () => { throw new Error("TODO"); };\n`); // untracked work counts too
    const s = settings({ excludePaths: ["legacy"], languages: { ...config.slop.languages, go: false } });
    const r = await scanWorkspace({ path: dir, baseRef: "main", settings: s, profile: "STANDARD" });
    assert.equal(r.status, "ok");
    assert.equal(r.files_scanned, 2);
    assert.deepEqual(r.skipped, [
      { path: "legacy/z.ts", reason: "excluded path" },
      { path: "svc/a.go", reason: "language disabled: go" },
    ]);
    assert.deepEqual(
      r.findings.map((f) => `${f.status}:${f.rule}:${f.path}:${f.line}`).sort(),
      ["existing:silent-error:src/pay.ts:3", "new:placeholder:src/new.js:1", "new:unreachable-code:src/pay.ts:5"],
    );
    assert.equal(r.llm_tokens, 0);
    assert.deepEqual(r.unsupported_rules, UNSUPPORTED_RULES);
    assert.ok(r.detector_ms >= 0 && r.level === "standard");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan: cache hit on identical input; content, detector version or thresholds invalidate", async () => {
  const { dir, write } = repo();
  try {
    write("src/pay.ts", `export function pay() {\n  try { a(); } catch (e) {}\n  return 9;\n}\n`);
    const opts = { path: dir, baseRef: "main", settings: settings({ level: "standard" }) };
    const first = await scanWorkspace({ ...opts, detectorVersion: "cache-test-1" });
    const again = await scanWorkspace({ ...opts, detectorVersion: "cache-test-1" });
    assert.equal(again.cache_hits, first.cache_hits + 2, "base and head both served from cache");
    assert.equal((await scanWorkspace({ ...opts, detectorVersion: "cache-test-2" })).cache_hits, 0);
    const thresholds = { ...config.slop.thresholds, cyclomatic: 99 };
    assert.equal((await scanWorkspace({ ...opts, detectorVersion: "cache-test-1", settings: settings({ level: "standard", thresholds }) })).cache_hits, 0);
    write("src/pay.ts", `export function pay() {\n  try { a(); } catch (e) {}\n  return 10;\n}\n`);
    assert.equal((await scanWorkspace({ ...opts, detectorVersion: "cache-test-1" })).cache_hits, 1, "only the unchanged base side hits");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan: a grammar that fails to load is an explicit error, never zero findings", async () => {
  const { dir, write } = repo();
  try {
    write("src/pay.ts", `export function pay() { return 2; }\n`);
    const r = await scanWorkspace({
      path: dir,
      baseRef: "main",
      settings: settings(),
      detectorVersion: "grammar-failure",
      parse: async (language) => {
        throw new ParserLoadError(language, new Error("wasm missing"));
      },
    });
    assert.equal(r.status, "error");
    assert.deepEqual(r.errors, [{ path: "src/pay.ts", error: "Parser unavailable (typescript)" }]);
    assert.equal(r.files_scanned, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- verification harness (fake deps, no model)
const CFG: VerifyConfig = { command: "make verify", maxRepairs: 2, timeoutMs: 60_000, baseline: null, allowTestWeakening: true };
const WT = mkdtempSync(join(tmpdir(), "slop-verify-"));
execFileSync("git", ["-C", WT, "init", "-q"]);
writeFileSync(join(WT, "a.txt"), "x");
execFileSync("git", ["-C", WT, "add", "."]);
execFileSync("git", ["-C", WT, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base"]);
const WS = [{ repo: "svc", path: WT }];
const never = new AbortController().signal;
const PASS: VerifyDeps["run"] = async () => ({ code: 0, output: "ℹ pass 3\n", timedOut: false });
const finding = (fp: string) => ({
  rule: "silent-error", category: "error-handling", severity: "high" as const, confidence: 0.9, kind: "deterministic" as const,
  path: "src/pay.ts", line: 3, symbol: "pay", snippet: "catch (e) {}", message: "error swallowed silently: empty handler", fingerprint: fp, status: "new" as const,
});
const report = (mode: string, fps: string[], block: boolean): SlopVerification => ({
  status: "ok", level: "standard", detector_version: DETECTOR_VERSION, mode,
  findings: fps.map(finding), blocking: block ? fps.map(finding) : [],
  counts: { new: fps.length, worsened: 0, existing: 0, resolved: 0, suppressed: 0 }, by_category: { "error-handling": fps.length },
  files_scanned: 1, cache_hits: 0, detector_ms: 3, llm_tokens: 0, unsupported_rules: UNSUPPORTED_RULES, skipped: [], errors: [],
});

test("verify: advisory findings are reported but the round passes", async () => {
  const r = await verifyWorkspaces(WS, [WT], CFG, 1, never, { run: PASS, slop: async () => report("advisory", ["f1"], false) });
  assert.equal(r.passed, true);
  assert.equal(r.repos[0].slop?.findings.length, 1);
  const summary = verificationSummary(CFG, { outcome: "passed", rounds: [r], repairs: 0 });
  assert.deepEqual([summary.slop?.counts.new, summary.slop?.llm_tokens, summary.slop?.blocking.length], [1, 0, 0]);
  assert.equal(summary.last[0].slop?.findings.length, 1);
});

test("verify: enforcement blocks, repairs in the same loop, then passes; repair prompt carries findings and safety rules", async () => {
  let fixed = false;
  const prompts: string[] = [];
  const deps: VerifyDeps = { run: PASS, slop: async () => report("enforcement", fixed ? [] : ["f1"], true) };
  const loop = await verificationLoop({
    cfg: CFG,
    signal: never,
    verify: (n) => verifyWorkspaces(WS, [WT], CFG, n, never, deps),
    repair: async (failed, n) => {
      prompts.push(repairPrompt(failed, n, CFG));
      fixed = true;
      return undefined;
    },
  });
  assert.deepEqual([loop.outcome, loop.repairs, prompts.length], ["passed", 1, 1]);
  assert.equal(loop.rounds[0].repos[0].status, "failed");
  assert.match(prompts[0], /Slop findings to fix/);
  assert.match(prompts[0], /silent-error src\/pay\.ts:3 \(pay\)/);
  assert.match(prompts[0], /<untrusted_input source="slop:svc">/);
  assert.match(prompts[0], /Never remove security checks, business invariants, idempotency/);
});

test("verify: enforcement findings that persist exhaust the budget (failed) or repeat identically (no_progress)", async () => {
  let n = 0;
  const changing: VerifyDeps = { run: PASS, slop: async () => report("enforcement", [`f${n++}`], true) };
  const exhausted = await verificationLoop({
    cfg: CFG, signal: never,
    verify: (i) => verifyWorkspaces(WS, [WT], CFG, i, never, changing),
    repair: async () => undefined,
  });
  assert.deepEqual([exhausted.outcome, exhausted.repairs], ["failed", 2]);
  const summary = verificationSummary(CFG, exhausted);
  assert.deepEqual(summary.slop?.blocking.map((b) => `${b.rule} ${b.path}:${b.line}`), ["silent-error src/pay.ts:3"]);
  const same: VerifyDeps = { run: PASS, slop: async () => report("enforcement", ["same"], true) };
  const stuck = await verificationLoop({
    cfg: CFG, signal: never,
    verify: (i) => verifyWorkspaces(WS, [WT], CFG, i, never, same),
    repair: async () => undefined,
  });
  assert.equal(stuck.outcome, "no_progress");
  assert.match(stuck.rounds[0].signature, /\|slop:same/);
});

test("verify: a failing detector never fails or passes verification by itself; it is flagged for review", async () => {
  const r = await verifyWorkspaces(WS, [WT], CFG, 1, never, {
    run: PASS,
    slop: async () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual([r.passed, r.repos[0].status, r.repos[0].slop?.status, r.needs_review], [true, "passed", "error", true]);
  assert.match(r.repos[0].slop!.errors[0].error, /boom/);
  const disabled = await verifyWorkspaces(WS, [WT], CFG, 1, never, { run: PASS, slop: async () => null });
  assert.equal(disabled.repos[0].slop, undefined);
  assert.equal("slop" in verificationSummary(CFG, { outcome: "passed", rounds: [disabled], repairs: 0 }), false);
});
