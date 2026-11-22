/**
 * Production Bug Hunter — the deterministic rules (no I/O). Everything here decides from platform-collected evidence;
 * an agent's claim can only lower a status, never raise one:
 *
 *  - A candidate becomes a CONFIRMED bug only after a separate verifier step said CONFIRMED AND the platform holds
 *    proof: its own reproduction run failed the verifier's focused test, or every code excerpt the verifier cited is
 *    present at the cited lines of the investigated revision (with a stated execution path).
 *  - Incident causality is a second, separate verdict. A confirmed code bug is a CONFIRMED incident cause only when the
 *    persisted incident evidence (stack frames / caller / emitted error text) points at the same code, the code is the
 *    one production ran, and the verifier found the link supported.
 */
import { createHash } from "node:crypto";

export type BugStatus = "CONFIRMED" | "SUSPECTED" | "REJECTED" | "BLOCKED";
export type CausalityStatus =
  "CONFIRMED" | "PROBABLE" | "NOT_SUPPORTED" | "UNKNOWN" | "NOT_APPLICABLE";

export const DEFECT_CATEGORIES = [
  "business_logic",
  "race_condition",
  "deadlock",
  "retry_amplification",
  "idempotency",
  "error_handling",
  "resource_leak",
  "transaction_consistency",
  "state_transition",
  "boundary_condition",
  "data_corruption",
  "nil_handling",
  "cancellation",
  "other",
] as const;

export interface Frame {
  function: string | null;
  file: string;
  line: number;
}

/** Go-style frames (`pkg.Func(...)\n\t/abs/path/file.go:123 +0x1f`) and `file.go:line` callers, in order, deduplicated. */
export function parseFrames(stack: string | undefined | null, caller?: string | null): Frame[] {
  const out: Frame[] = [];
  const seen = new Set<string>();
  const push = (f: Frame) => {
    const k = `${f.file}:${f.line}`;
    if (seen.has(k) || out.length >= 40) return;
    seen.add(k);
    out.push(f);
  };
  const lines = String(stack ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /([\w@./+-]+\.(?:go|ts|js|java|py|kt)):(\d+)/.exec(lines[i]);
    if (!m) continue;
    const prev = i > 0 ? lines[i - 1].trim() : "";
    const fn = /^([\w./*()+-]+?)\(.*\)$/.exec(prev)?.[1] ?? null;
    if (/\/(?:runtime|testing|net\/http)\/[^/]+\.go$/.test(m[1]) || m[1].includes("/go/pkg/mod/"))
      continue;
    push({ function: fn ? fn.split("/").pop()! : null, file: m[1], line: Number(m[2]) });
  }
  const c = /([\w@./+-]+\.(?:go|ts|js|java|py|kt)):(\d+)/.exec(String(caller ?? ""));
  // The logged caller is usually the top frame again (relative path): keep it only when it is a new location.
  if (
    c &&
    !out.some((f) => f.line === Number(c[2]) && (f.file === c[1] || f.file.endsWith(`/${c[1]}`)))
  )
    push({ function: null, file: c[1], line: Number(c[2]) });
  return out;
}

/** The repository file a frame refers to: the tracked path with the longest common suffix (whole path segments). */
export function matchFile(framePath: string, tracked: string[]): string | null {
  const parts = framePath.split("/").filter(Boolean);
  let best: string | null = null;
  let bestLen = 0;
  for (const t of tracked) {
    const tp = t.split("/");
    let n = 0;
    while (
      n < parts.length &&
      n < tp.length &&
      parts[parts.length - 1 - n] === tp[tp.length - 1 - n]
    )
      n++;
    if (n > bestLen || (n === bestLen && n > 0 && best && t.length < best.length)) {
      best = n ? t : best;
      bestLen = n;
    }
  }
  return bestLen ? best : null;
}

export interface FunctionSpan {
  name: string;
  receiver: string | null;
  start: number;
  end: number;
}

/** Go function declarations in a file (top-level `func` to the closing `}` at column 0). */
export function goFunctions(source: string): FunctionSpan[] {
  const lines = source.split("\n");
  const out: FunctionSpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^func\s+(?:\(\s*\w*\s*\*?\s*([\w.[\]]+)\s*\)\s*)?(\w+)\s*[[(]/.exec(lines[i]);
    if (!m) continue;
    let end = i;
    if (!/}\s*$/.test(lines[i]) || /{\s*$/.test(lines[i]))
      for (let j = i + 1; j < lines.length; j++)
        if (/^}/.test(lines[j])) {
          end = j;
          break;
        }
    out.push({
      name: m[2],
      receiver: m[1]?.replace(/\[.*$/, "") ?? null,
      start: i + 1,
      end: end + 1,
    });
  }
  return out;
}

export function enclosingFunction(source: string, line: number): FunctionSpan | null {
  return goFunctions(source).find((f) => f.start <= line && line <= f.end) ?? null;
}

/** "(*Service).Charge" / "Service.Charge" / "Charge" → the bare function name. */
export const bareName = (fn: string) => fn.replace(/^.*[.)]/, "").replace(/[^\w].*$/, "");

export function confidenceValue(c: unknown): number {
  if (typeof c === "number" && Number.isFinite(c))
    return Math.max(0, Math.min(1, c > 1 ? c / 100 : c));
  const s = String(c ?? "").toLowerCase();
  return s === "high" ? 0.85 : s === "medium" ? 0.6 : s === "low" ? 0.3 : 0;
}

export function normalizeCategory(c: unknown): string {
  const s = String(c ?? "")
    .toLowerCase()
    .replace(/[^a-z]+/g, "_")
    .replace(/^_|_$/g, "");
  if ((DEFECT_CATEGORIES as readonly string[]).includes(s)) return s;
  if (/nil|null/.test(s)) return "nil_handling";
  if (/race|concurren/.test(s)) return "race_condition";
  if (/idempot|duplicate/.test(s)) return "idempotency";
  if (/retry/.test(s)) return "retry_amplification";
  if (/transact|consisten/.test(s)) return "transaction_consistency";
  if (/cancel|context/.test(s)) return "cancellation";
  if (/leak/.test(s)) return "resource_leak";
  if (/error/.test(s)) return "error_handling";
  if (/state/.test(s)) return "state_transition";
  if (/bound|off_by|overflow/.test(s)) return "boundary_condition";
  return "other";
}

/** One defect at one place: repository, file, function and defect category (lines drift, wording varies). */
export const dedupeKey = (c: {
  repository: string;
  file_path: string;
  function: string;
  category: string;
}) =>
  createHash("sha256")
    .update([c.repository, c.file_path, bareName(c.function).toLowerCase(), c.category].join("\0"))
    .digest("hex")
    .slice(0, 24);

export interface Candidate {
  id: string;
  repository: string;
  commit: string;
  file_path: string;
  function: string;
  line_start: number;
  line_end: number;
  category: string;
  hypothesis: string;
  trigger: string;
  expected: string;
  actual: string;
  supporting_evidence: string[];
  reproduction_strategy: string;
  confidence: number;
  uncertainty: string;
  dedupe_key: string;
}

const str = (v: unknown, n = 2000) =>
  String(v ?? "")
    .trim()
    .slice(0, n);

/** Shape the hunter's raw candidates; anything without a location or a hypothesis is not a candidate. */
export function normalizeCandidates(raw: unknown): {
  candidates: Candidate[];
  malformed: Array<{ index: number; reason: string }>;
} {
  const list = Array.isArray(raw) ? raw.slice(0, 30) : [];
  const candidates: Candidate[] = [];
  const malformed: Array<{ index: number; reason: string }> = [];
  list.forEach((r, index) => {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const lr = Array.isArray(o.line_range) ? o.line_range : [];
    const start = Number(o.line_start ?? lr[0]);
    const end = Number(o.line_end ?? lr[1] ?? start);
    const c = {
      repository: str(o.repository, 200),
      commit: str(o.commit, 64),
      file_path: str(o.file_path, 400).replace(/^\.\//, ""),
      function: str(o.function, 200),
      line_start: Number.isInteger(start) && start > 0 ? start : 0,
      line_end: Number.isInteger(end) && end >= start ? end : Number.isInteger(start) ? start : 0,
      category: normalizeCategory(o.category),
      hypothesis: str(o.hypothesis),
      trigger: str(o.trigger),
      expected: str(o.expected),
      actual: str(o.actual),
      supporting_evidence: (Array.isArray(o.supporting_evidence) ? o.supporting_evidence : [])
        .slice(0, 10)
        .map((e) => str(typeof e === "string" ? e : JSON.stringify(e), 600)),
      reproduction_strategy: str(o.reproduction_strategy),
      confidence: confidenceValue(o.confidence),
      uncertainty: str(o.uncertainty),
    };
    const missing = (["repository", "file_path", "function", "hypothesis"] as const).filter(
      (k) => !c[k],
    );
    if (!c.line_start) missing.push("line_start" as never);
    if (missing.length) return malformed.push({ index, reason: `missing ${missing.join(", ")}` });
    if (c.file_path.startsWith("/") || c.file_path.split("/").includes(".."))
      return malformed.push({ index, reason: "file_path must be relative to the repository" });
    candidates.push({ ...c, id: "", dedupe_key: dedupeKey(c) });
  });
  return { candidates, malformed };
}

/** Same defect twice → one candidate (highest confidence; evidence merged). Stable C1, C2… ids. */
export function dedupeCandidates(list: Candidate[]) {
  const byKey = new Map<string, Candidate>();
  const duplicates: Array<{ dedupe_key: string; merged: number }> = [];
  for (const c of list) {
    const prev = byKey.get(c.dedupe_key);
    if (!prev) {
      byKey.set(c.dedupe_key, { ...c });
      continue;
    }
    const keep = c.confidence > prev.confidence ? { ...c } : prev;
    keep.supporting_evidence = [
      ...new Set([...prev.supporting_evidence, ...c.supporting_evidence]),
    ].slice(0, 10);
    byKey.set(c.dedupe_key, keep);
    const d = duplicates.find((x) => x.dedupe_key === c.dedupe_key);
    if (d) d.merged++;
    else duplicates.push({ dedupe_key: c.dedupe_key, merged: 1 });
  }
  const out = [...byKey.values()].sort((a, b) => b.confidence - a.confidence);
  out.forEach((c, i) => (c.id = `C${i + 1}`));
  return { candidates: out, duplicates };
}

/** What the independent verifier is given: the claim and its location — never the hunter's reasoning or evidence text. */
export const claimForVerifier = (c: Candidate) => ({
  id: c.id,
  repository: c.repository,
  commit: c.commit,
  file_path: c.file_path,
  function: c.function,
  line_start: c.line_start,
  line_end: c.line_end,
  category: c.category,
  claim: c.hypothesis,
  trigger: c.trigger,
  expected: c.expected,
  actual: c.actual,
});

// ---------------------------------------------------------------- verdicts

export type ReproOutcome =
  "reproduced" | "not_reproduced" | "invalid" | "timeout" | "blocked" | "canceled";

export interface VerifierVerdict {
  id: string;
  verdict: BugStatus;
  reason: string;
  execution_path: string[];
  code_evidence: Array<{
    file_path: string;
    line_start: number;
    line_end: number;
    excerpt: string;
  }>;
  alternative_explanations: string[];
  incident_link: "SUPPORTED" | "NOT_SUPPORTED" | "UNKNOWN";
  incident_link_reason: string;
  reproduction: {
    test_file: string;
    test_name: string;
    package_dir: string;
    test_code: string;
  } | null;
}

const VERDICTS = new Set(["CONFIRMED", "SUSPECTED", "REJECTED", "BLOCKED"]);

/** The verifier's output, fail-closed: an unknown verdict is BLOCKED, never CONFIRMED. */
export function parseVerifierOutput(raw: unknown, ids: string[]): Map<string, VerifierVerdict> {
  const out = new Map<string, VerifierVerdict>();
  const list = Array.isArray((raw as { verdicts?: unknown })?.verdicts)
    ? ((raw as { verdicts: unknown[] }).verdicts as unknown[])
    : [];
  for (const r of list) {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const id = str(o.id, 20);
    if (!ids.includes(id) || out.has(id)) continue;
    const v = str(o.verdict, 20).toUpperCase();
    const rep = (
      o.reproduction && typeof o.reproduction === "object" ? o.reproduction : null
    ) as Record<string, unknown> | null;
    const link = str(o.incident_link, 20).toUpperCase();
    out.set(id, {
      id,
      verdict: VERDICTS.has(v) ? (v as BugStatus) : "BLOCKED",
      reason: str(o.reason) || (VERDICTS.has(v) ? "" : `unrecognized verdict "${v}"`),
      execution_path: (Array.isArray(o.execution_path) ? o.execution_path : [])
        .slice(0, 20)
        .map((x) => str(x, 400)),
      code_evidence: (Array.isArray(o.code_evidence) ? o.code_evidence : [])
        .slice(0, 10)
        .map((e) => {
          const x = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
          return {
            file_path: str(x.file_path, 400).replace(/^\.\//, ""),
            line_start: Number(x.line_start) || 0,
            line_end: Number(x.line_end ?? x.line_start) || 0,
            excerpt: str(x.excerpt, 1200),
          };
        }),
      alternative_explanations: (Array.isArray(o.alternative_explanations)
        ? o.alternative_explanations
        : []
      )
        .slice(0, 10)
        .map((x) => str(x, 600)),
      incident_link: link === "SUPPORTED" || link === "NOT_SUPPORTED" ? link : "UNKNOWN",
      incident_link_reason: str(o.incident_link_reason, 1000),
      reproduction:
        rep && rep.test_code
          ? {
              test_file: str(rep.test_file, 300).replace(/^\.\//, ""),
              test_name: str(rep.test_name, 120),
              package_dir: str(rep.package_dir, 300)
                .replace(/^\.\/?/, "")
                .replace(/\/$/, ""),
              test_code: String(rep.test_code ?? "").slice(0, 20_000),
            }
          : null,
    });
  }
  return out;
}

/** Excerpt check: the cited text (whitespace-normalized) occurs within the cited lines (±2) of the file. */
export function excerptMatches(
  source: string,
  e: { line_start: number; line_end: number; excerpt: string },
) {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const want = norm(e.excerpt);
  if (want.length < 8 || !e.line_start) return false;
  const lines = source.split("\n");
  if (e.line_start > lines.length) return false;
  const from = Math.max(0, e.line_start - 3);
  const to = Math.min(lines.length, Math.max(e.line_end, e.line_start) + 2);
  return norm(lines.slice(from, to).join("\n")).includes(want);
}

export interface Decision {
  bug_verification_status: BugStatus;
  basis: string;
  incident_causality_status: CausalityStatus;
  causality_basis: string[];
}

/**
 * The final verdict for one verified candidate. `codeEvidenceVerified` is the platform's excerpt check; `link` is what
 * the persisted incident evidence says about the candidate's location.
 */
export function decide(x: {
  verdict: VerifierVerdict | null;
  verifierRan: boolean;
  repro: { outcome: ReproOutcome; detail?: string } | null;
  codeEvidenceVerified: boolean;
  link: {
    inPath: boolean;
    /** Called from a function on the incident's stack (a callee on the failing path, not the failing frame). */
    calledFromPath?: boolean;
    emitsError: boolean;
    incidentEvidence: boolean;
    productionMatch: boolean | null;
  };
}): Decision {
  let status: BugStatus;
  let basis: string;
  const v = x.verdict;
  if (!v) {
    status = x.verifierRan ? "SUSPECTED" : "BLOCKED";
    basis = x.verifierRan
      ? "the independent verifier returned no verdict for this candidate"
      : "independent verification did not run";
  } else if (v.verdict !== "CONFIRMED") {
    status = v.verdict;
    basis = `independent verifier: ${v.verdict}${v.reason ? ` — ${v.reason}` : ""}`;
  } else if (x.repro?.outcome === "reproduced") {
    status = "CONFIRMED";
    basis =
      "independent verifier CONFIRMED and the platform's isolated reproduction test failed as claimed";
  } else if (x.repro) {
    // The verifier itself judged a test necessary: without its result the claim is not proven.
    const env =
      x.repro.outcome === "blocked" ||
      x.repro.outcome === "timeout" ||
      x.repro.outcome === "canceled";
    status = env ? "BLOCKED" : "SUSPECTED";
    basis =
      x.repro.outcome === "not_reproduced"
        ? "the verifier's reproduction test PASSED on the investigated revision: the defect was not demonstrated"
        : `the verifier's reproduction could not prove it (${x.repro.outcome}${x.repro.detail ? `: ${x.repro.detail}` : ""})`;
  } else if (x.codeEvidenceVerified && v.execution_path.length) {
    status = "CONFIRMED";
    basis =
      "independent verifier CONFIRMED from code without a reproduction: every cited excerpt is present at the cited lines of the investigated revision and an execution path was stated";
  } else {
    status = "SUSPECTED";
    basis = `independent verifier said CONFIRMED but the platform could not establish proof (no reproduction; ${
      x.codeEvidenceVerified
        ? "no execution path stated"
        : "cited code excerpts not found at the revision"
    })`;
  }
  const why: string[] = [];
  let causality: CausalityStatus;
  if (status === "REJECTED") causality = "NOT_APPLICABLE";
  else if (!x.link.incidentEvidence) {
    causality = "UNKNOWN";
    why.push("the incident has no persisted stack frame, caller or error text to link code to");
  } else if (!x.link.inPath && !x.link.emitsError && !x.link.calledFromPath) {
    causality = "NOT_SUPPORTED";
    why.push("the incident's stack frames, caller and error text do not reach this code");
  } else {
    if (x.link.inPath) why.push("the location is on the incident's stack/caller path");
    else if (x.link.calledFromPath)
      why.push(
        "the function is called from a function on the incident's stack (not itself a failing frame)",
      );
    if (x.link.emitsError) why.push("the function emits the incident's error text");
    const prod = x.link.productionMatch;
    if (prod === false) why.push("the investigated code differs from the commit production ran");
    if (prod === null) why.push("the production commit is unknown");
    if (v?.incident_link !== "SUPPORTED")
      why.push(`the verifier judged the incident link ${v?.incident_link ?? "UNKNOWN"}`);
    causality =
      status === "CONFIRMED" &&
      (x.link.inPath || x.link.emitsError) &&
      prod === true &&
      v?.incident_link === "SUPPORTED"
        ? "CONFIRMED"
        : "PROBABLE";
  }
  return {
    bug_verification_status: status,
    basis,
    incident_causality_status: causality,
    causality_basis: why,
  };
}

// ---------------------------------------------------------------- reproduction command (no free-form shell)

export const REPRO_LIMITS = { maxPerHunt: 3, timeoutMs: 120_000, maxTestBytes: 20_000 };

/** A reproduction the platform will run: a NEW Go test file inside the package directory and nothing else. */
export function validateReproduction(
  r: VerifierVerdict["reproduction"],
  exists: (path: string) => boolean,
): { ok: true; command: string } | { ok: false; reason: string } {
  if (!r) return { ok: false, reason: "no reproduction proposed" };
  const dir = r.package_dir;
  if (!/^[\w./-]*$/.test(dir) || dir.split("/").includes("..") || dir.startsWith("/"))
    return { ok: false, reason: "package_dir must be a relative directory" };
  if (!/^[\w./-]+_test\.go$/.test(r.test_file) || r.test_file.split("/").includes(".."))
    return { ok: false, reason: "test_file must be a relative *_test.go path" };
  const parent = r.test_file.includes("/")
    ? r.test_file.slice(0, r.test_file.lastIndexOf("/"))
    : "";
  if (parent !== dir) return { ok: false, reason: "test_file must be directly inside package_dir" };
  if (exists(r.test_file))
    return { ok: false, reason: "test_file already exists (existing files are never overwritten)" };
  if (!/^Test[A-Za-z0-9_]+$/.test(r.test_name))
    return { ok: false, reason: "test_name must be a Go test name" };
  if (!new RegExp(`func\\s+${r.test_name}\\s*\\(`).test(r.test_code))
    return { ok: false, reason: "test_code does not define test_name" };
  if (Buffer.byteLength(r.test_code) > REPRO_LIMITS.maxTestBytes)
    return { ok: false, reason: "test_code too large" };
  return {
    ok: true,
    command: `go test -count=1 -buildvcs=false -run '^${r.test_name}$' ./${dir || "."}`,
  };
}

/** Outcome of the focused test run. Only an assertion failure of the named test counts as a reproduction. */
export function classifyRepro(
  testName: string,
  r: { code: number | null; output: string; timedOut: boolean },
  canceled = false,
): { outcome: ReproOutcome; detail: string } {
  const out = r.output;
  if (canceled) return { outcome: "canceled", detail: "canceled" };
  if (r.timedOut) return { outcome: "timeout", detail: "the focused test timed out" };
  if (
    /module lookup disabled|GOPROXY=off|cannot find module|missing go\.sum entry|go: downloading/.test(
      out,
    )
  )
    return {
      outcome: "blocked",
      detail:
        "dependencies are not available offline (network access is disabled for reproductions)",
    };
  if (new RegExp(`--- FAIL: ${testName}\\b`).test(out))
    return { outcome: "reproduced", detail: "the focused test failed" };
  if (new RegExp(`--- PASS: ${testName}\\b`).test(out) || (r.code === 0 && /^ok\s/m.test(out)))
    return { outcome: "not_reproduced", detail: "the focused test passed" };
  if (/no tests to run|testing: warning: no tests/.test(out))
    return { outcome: "invalid", detail: "the named test did not run" };
  if (/\[build failed\]|\[setup failed\]|cannot use|undefined:|syntax error|expected /.test(out))
    return { outcome: "invalid", detail: "the reproduction test does not compile" };
  return { outcome: "invalid", detail: `unrecognized test outcome (exit ${r.code})` };
}
