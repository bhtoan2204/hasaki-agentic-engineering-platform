import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles, collectScopeState, evaluateScope, normalizeScopePath, prePublishProblems, renewedApprovalFor, scopeRevision, SCOPE_REVISION_TAG, worktreeFingerprint } from "../src/agent/scopeGuard.ts";
import { normalizeInvestigationOutput, scopeCheck, SCOPE_REAPPROVAL_QUESTION, type ApprovedScope } from "../src/agent/evidence.ts";
import { applyProvenance, verifyClaimProvenance, withProvenance, type ProvenanceEnv } from "../src/agent/provenance.ts";
import { reusablePass, unresolvedScope, verificationGate, verificationKey } from "../src/agent/independentReview.ts";
import { classifyFailure } from "../src/workflow/failures.ts";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: GIT_ENV }).trim();
const write = (root: string, file: string, content: string) => {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), content);
};
function repo() {
  const path = mkdtempSync(join(tmpdir(), "hardening-"));
  g(path, "init", "-q", "-b", "feature");
  write(path, "app/refund.go", "package app\n\nfunc Refund() int {\n\treturn 1\n}\n");
  g(path, "add", "-A");
  g(path, "commit", "-qm", "base");
  g(path, "update-ref", "refs/remotes/origin/main", "HEAD");
  return path;
}
const SCOPE: ApprovedScope = {
  source_step: "approve",
  proposal_hash: "hash-1",
  summary: "fix refund",
  changes: [{ repo: "svc", files: ["app/refund.go", "svc/app/money/"], description: "fix" }],
  risk: "LOW",
  root_cause_status: null,
  gate: null,
  assumptions: [],
  prohibited_assumptions: [],
  required_tests: ["integration/refund_flow_test.go"],
};

// ---------------------------------------------------------------- scope: paths

test("scope paths: traversal, absolute, backslash, ambiguous and wildcard paths are violations, never matches", () => {
  for (const [p, why] of [
    ["../etc/passwd", /traversal/],
    ["app/../../x.go", /traversal/],
    ["/abs/app.go", /absolute/],
    ["C:/x.go", /absolute/],
    ["app\\x.go", /backslash/],
    ["app//x.go", /ambiguous/],
    ["app/./x.go", /ambiguous/],
    ["app/*.go", /wildcard/],
    ["", /empty/],
  ] as const)
    assert.match((normalizeScopePath(p) as any).invalid ?? "", why, p);
  assert.deepEqual(normalizeScopePath("./app/x.go:12-20"), { path: "app/x.go", dir: false });
  assert.deepEqual(normalizeScopePath("svc/app/x.go", "svc"), { path: "app/x.go", dir: false }, "repo-prefixed approved entries");
  assert.deepEqual(normalizeScopePath("app/money/**", "", true), { path: "app/money", dir: true });
  const ev = evaluateScope(SCOPE, { svc: ["app/refund.go", "../outside.go"] });
  assert.deepEqual(ev.invalid_paths, ["svc:../outside.go (path traversal (..))"]);
});

test("scope: an undeclared out-of-scope change requires renewed approval without any agent declaration", () => {
  const c = scopeCheck(SCOPE, { svc: ["app/refund.go", "app/ledger.go"] }, [], "rev1");
  assert.deepEqual(c.out_of_scope_files, ["svc:app/ledger.go"]);
  assert.equal(c.deviations.length, 0, "the agent declared nothing");
  assert.equal(c.requires_reapproval, true);
  assert.equal(c.revision, "rev1");
  assert.match(c.reasons[0], /app\/ledger\.go is outside the approved scope/);
  assert.equal(scopeCheck(SCOPE, { svc: ["app/refund.go", "app/money/fx.go"] }, []).requires_reapproval, false, "approved file + approved directory");
  assert.equal(scopeCheck(SCOPE, { svc: ["app/moneybag.go"] }, []).requires_reapproval, true, "a directory prefix is not a string prefix");
});

test("scope: test files get no blanket exemption", () => {
  const ev = evaluateScope(SCOPE, {
    svc: ["app/refund_test.go", "app/ledger_test.go", "integration/refund_flow_test.go", "test/fixtures/big.json"],
    other: ["app/refund_test.go"],
  });
  assert.deepEqual(ev.out_of_scope_files.sort(), ["other:app/refund_test.go", "svc:app/ledger_test.go", "svc:test/fixtures/big.json"].sort());
  assert.deepEqual(ev.unauthorized_repos, ["other"], "a test file in an unapproved repository is out of scope");
  assert.ok(!ev.out_of_scope_files.includes("svc:app/refund_test.go"), "the companion test of an approved file is in scope");
  assert.ok(!ev.out_of_scope_files.includes("svc:integration/refund_flow_test.go"), "named by required_tests");
});

// ---------------------------------------------------------------- scope: git state and revisions

test("scope: committed, staged, unstaged and untracked changes are all collected", async () => {
  const path = repo();
  write(path, "app/committed.go", "package app\n");
  g(path, "add", "-A");
  g(path, "commit", "-qm", "c");
  write(path, "app/staged.go", "package app\n");
  g(path, "add", "app/staged.go");
  write(path, "app/refund.go", "package app // unstaged edit\n");
  write(path, "app/untracked.go", "package app\n");
  const ch = await changedFiles(path, "origin/main");
  assert.deepEqual(ch.committed, ["app/committed.go"]);
  assert.deepEqual(ch.staged, ["app/staged.go"]);
  assert.deepEqual(ch.unstaged, ["app/refund.go"]);
  assert.deepEqual(ch.untracked, ["app/untracked.go"]);
  assert.deepEqual(ch.all, ["app/committed.go", "app/refund.go", "app/staged.go", "app/untracked.go"]);
  const st = await collectScopeState([{ repo: "svc", path, base: "origin/main" }, { repo: "ghost", path: join(path, "missing"), base: "origin/main" }]);
  assert.equal(st.files.svc.length, 4);
  assert.match(st.unreadable[0], /^ghost: cannot read changes/, "unreadable repositories fail closed");
});

test("scope: a renewed approval binds to the exact revision — a diff changing after approval needs approval again", async () => {
  const path = repo();
  write(path, "app/ledger.go", "package app // v1\n");
  g(path, "add", "-A");
  g(path, "commit", "-qm", "out of scope");
  const st1 = await collectScopeState([{ repo: "svc", path, base: "origin/main" }]);
  const rev1 = scopeRevision(SCOPE.proposal_hash, st1.files, st1.states);
  const answers = [{ question: `${SCOPE_REAPPROVAL_QUESTION} ${SCOPE_REVISION_TAG(rev1)}: svc:app/ledger.go …`, answer: "Approve this exact change set" }];
  assert.deepEqual(renewedApprovalFor(answers, SCOPE_REAPPROVAL_QUESTION, rev1), { answer: "Approve this exact change set", revision: rev1 });
  assert.equal(renewedApprovalFor([{ ...answers[0], answer: "Reject: revert" }], SCOPE_REAPPROVAL_QUESTION, rev1), null);
  const publish = { svc: { head: g(path, "rev-parse", "HEAD"), branchTip: g(path, "rev-parse", "refs/heads/feature"), dirty: "" } };
  assert.deepEqual(prePublishProblems({ publish, scope: SCOPE, state: st1, renewedRevision: rev1, tested: [] }), [], "approved revision publishes");

  // Same file set, different content (an unstaged edit, then a new commit): a new revision.
  write(path, "app/ledger.go", "package app // v2 changed after approval\n");
  const fpDirty = await worktreeFingerprint(path);
  assert.notEqual(fpDirty.fingerprint, st1.states.svc, "uncommitted edits change the fingerprint");
  g(path, "commit", "-qam", "v2");
  const st2 = await collectScopeState([{ repo: "svc", path, base: "origin/main" }]);
  const rev2 = scopeRevision(SCOPE.proposal_hash, st2.files, st2.states);
  assert.notEqual(rev2, rev1);
  assert.equal(renewedApprovalFor(answers, SCOPE_REAPPROVAL_QUESTION, rev2), null, "the old approval does not cover the new diff");
  const publish2 = { svc: { head: g(path, "rev-parse", "HEAD"), branchTip: g(path, "rev-parse", "refs/heads/feature"), dirty: "" } };
  const problems = prePublishProblems({ publish: publish2, scope: SCOPE, state: st2, renewedRevision: rev1, tested: [] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], new RegExp(`scope drift: .*app/ledger\\.go.*covered revision ${rev1}, the code is now at ${rev2}`));
});

test("pre-publish gate: tested commit must equal the published commit; dirty trees refused; legacy runs skip scope", () => {
  const publish = { svc: { head: "b".repeat(40), branchTip: "b".repeat(40), dirty: "" } };
  assert.deepEqual(prePublishProblems({ publish, scope: null, state: null, renewedRevision: null, tested: [{ step: "test", heads: { svc: "b".repeat(40) } }] }), []);
  assert.match(prePublishProblems({ publish, scope: null, state: null, renewedRevision: null, tested: [{ step: "test", heads: { svc: "a".repeat(40) } }] })[0], /tests in "test" ran on aaaaaaaaaaaa, but bbbbbbbbbbbb would be published/);
  assert.match(prePublishProblems({ publish: { svc: { ...publish.svc, dirty: "?? x" } }, scope: null, state: null, renewedRevision: null, tested: [] })[0], /uncommitted or untracked/);
  assert.match(prePublishProblems({ publish: { svc: { ...publish.svc, head: "c".repeat(40) } }, scope: null, state: null, renewedRevision: null, tested: [] })[0], /not the tip of the pushed branch/);
});

// ---------------------------------------------------------------- reviewer cannot override deterministic failures

test("review: a PASS never overrides an unresolved scope violation, a BLOCKED verdict stays blocking", () => {
  assert.deepEqual(unresolvedScope([{ key: "implement", sc: { requires_reapproval: true, reapproved: null, reasons: ["svc:app/ledger.go is outside the approved scope"] } }]), ["implement: svc:app/ledger.go is outside the approved scope"]);
  assert.deepEqual(unresolvedScope([{ key: "implement", sc: { requires_reapproval: true, reapproved: { revision: "r" } } }]), []);
  const head = "d".repeat(40);
  const publish = { svc: { head, branchTip: head, dirty: "" } };
  const blocked = verificationGate([{ key: "review", status: "WAITING_INPUT", output: { independent: true, verdict: "BLOCKED", approved: false, verified_heads: { svc: head } } }], publish);
  assert.match(blocked[0], /no valid PASS/);
  const pass = { key: "review", status: "COMPLETED", output: { independent: true, verdict: "PASS", approved: true, verified_heads: { svc: head } } };
  assert.deepEqual(verificationGate([pass], publish), [], "the verifier gate alone would open…");
  const scopeState = { files: { svc: ["app/ledger.go"] }, states: { svc: "s" }, heads: { svc: head }, unreadable: [] };
  assert.match(prePublishProblems({ publish, scope: SCOPE, state: scopeState, renewedRevision: null, tested: [] })[0], /scope drift/, "…but the deterministic gate still blocks");
});

test("review reuse: only the identical commits + inputs + policy reuse a PASS; any change requires a new review", () => {
  const base = { heads: { svc: "a".repeat(40) }, baseTips: { svc: "0".repeat(40) }, diffText: "diff", tests: [["t", [{ passed: true }], null, true]], scope: ["h", null], stepConfig: { instructions: "review" }, provider: "claude" };
  const key = verificationKey(base);
  const prior = { output: { verdict: "PASS", approved: true, independent: true, verification_key: key, verified_heads: base.heads } };
  assert.equal(reusablePass(prior, key, base.heads), true);
  for (const change of [{ heads: { svc: "b".repeat(40) } }, { baseTips: { svc: "1".repeat(40) } }, { diffText: "diff2" }, { tests: [["t", [{ passed: false }], null, true]] }, { scope: ["h", "rev2"] }, { stepConfig: { instructions: "stricter" } }, { provider: "codex" }])
    assert.notEqual(verificationKey({ ...base, ...change }), key, JSON.stringify(change));
  assert.equal(reusablePass(prior, key, { svc: "b".repeat(40) }), false, "different commits");
  assert.equal(reusablePass(prior, key, { ...base.heads, other: "c".repeat(40) }), false, "an extra repository is not covered");
  assert.equal(reusablePass({ output: { ...prior.output, verdict: "BLOCKED" } }, key, base.heads), false);
  assert.equal(reusablePass({ output: { ...prior.output, verification_key: "old" } }, key, base.heads), false);
});

// ---------------------------------------------------------------- provenance

function provenanceEnv(path: string, tools: Record<number, string> = {}, artifacts: number[] = []): ProvenanceEnv {
  return {
    repoPath: async (r) => (r === "svc" ? path : null),
    currentRef: async () => "HEAD",
    toolCall: async (id) => (tools[id] ? { status: tools[id] } : null),
    artifact: async (id) => artifacts.includes(id),
  };
}

test("provenance: platform verifies repository, commit, file and lines; fake citations are CONTRADICTED", async () => {
  const path = repo();
  const sha = g(path, "rev-parse", "HEAD");
  const env = provenanceEnv(path);
  const fact = { claim: "Refund returns 1", classification: "CODE_FACT", repository: "svc", file_path: "app/refund.go", line_range: "3-5", commit: sha, verification_status: "verified" };
  const ok = await verifyClaimProvenance(fact, env);
  assert.deepEqual([ok.status, ok.verifies], ["VERIFIED_BY_PLATFORM", "location"], "the citation is real — which is all it proves");
  assert.equal((await verifyClaimProvenance({ ...fact, commit: "deadbeefdeadbeef" }, env)).status, "CONTRADICTED");
  assert.match((await verifyClaimProvenance({ ...fact, file_path: "app/nope.go" }, env)).reason!, /does not exist at/);
  assert.match((await verifyClaimProvenance({ ...fact, line_range: "40-90" }, env)).reason!, /outside app\/refund\.go .*\(5 lines\)/);
  assert.match((await verifyClaimProvenance({ ...fact, repository: "payments" }, env)).reason!, /not available to this run/);
  assert.equal((await verifyClaimProvenance({ ...fact, commit: "" }, env)).status, "UNVERIFIED");
  assert.equal((await verifyClaimProvenance({ ...fact, file_path: "../../etc/passwd" }, env)).status, "UNVERIFIED");
});

test("provenance: a stale source commit is UNVERIFIED and can no longer back a verified fact", async () => {
  const path = repo();
  const old = g(path, "rev-parse", "HEAD");
  write(path, "app/refund.go", "package app\n\nfunc Refund() int {\n\treturn 2 // changed since the citation\n}\n");
  g(path, "commit", "-qam", "change");
  const p = await verifyClaimProvenance({ repository: "svc", file_path: "app/refund.go", commit: old, line_range: "4" }, provenanceEnv(path));
  assert.deepEqual([p.status, p.stale], ["UNVERIFIED", true]);
  assert.match(p.reason!, /may be outdated/);
  const c = applyProvenance({ id: "F1", claim: "Refund returns 1", classification: "CODE_FACT", verification_status: "verified" }, p);
  assert.equal(c.verification_status, "unverified");
});

test("provenance: tool/artifact references must be records of this run; free-text sources are only AGENT_REPORTED; forged labels are stripped", async () => {
  const env = provenanceEnv("/nonexistent", { 7: "ok", 8: "error" }, [42]);
  assert.deepEqual(await verifyClaimProvenance({ source_ref: "tool_call:7", verification_status: "verified" }, env), { by: "platform", status: "VERIFIED_BY_PLATFORM", verifies: "source_record", reason: null });
  assert.equal((await verifyClaimProvenance({ source_ref: "tool_call:999", verification_status: "verified" }, env)).status, "CONTRADICTED", "fake tool call id");
  assert.equal((await verifyClaimProvenance({ source_ref: "tool_call:8" }, env)).status, "UNVERIFIED");
  assert.equal((await verifyClaimProvenance({ source_ref: "artifact:42" }, env)).status, "VERIFIED_BY_PLATFORM");
  assert.equal((await verifyClaimProvenance({ source_ref: "artifact:43" }, env)).status, "CONTRADICTED");
  assert.equal((await verifyClaimProvenance({ source_ref: "kibana log 10:42", verification_status: "verified" }, env)).status, "AGENT_REPORTED");
  const [forged] = (await withProvenance([{ claim: "x", source_ref: "tool_call:999", verification_status: "verified", provenance: { by: "platform", status: "VERIFIED_BY_PLATFORM" } }], env)) as any[];
  assert.equal(forged.provenance.status, "CONTRADICTED", "an agent-supplied provenance label is replaced");
  assert.equal(forged.verification_status, "contradicted");
});

test("provenance: an unsupported business claim keeps its text but cannot confirm a root cause", async () => {
  const path = repo();
  const env = provenanceEnv(path);
  const raw = [
    { id: "B1", claim: "Orders in status 7 are always refunded twice", classification: "OBSERVED_FACT", source_type: "log", source_ref: "tool_call:404", verification_status: "verified" },
    { id: "R", claim: "Double refund is caused by the retry job", classification: "CONFIRMED_ROOT_CAUSE", supports: ["B1"], verification_status: "verified" },
  ];
  const out = normalizeInvestigationOutput("root_cause", { claims: await withProvenance(raw, env), root_cause_assessment: { status: "CONFIRMED", explanation: "retry job" } });
  const b1 = out.claims.find((c: any) => c.id === "B1");
  assert.equal(b1.claim, "Orders in status 7 are always refunded twice", "the claim is preserved");
  assert.equal(b1.provenance.status, "CONTRADICTED");
  assert.notEqual(out.root_cause_assessment.status, "CONFIRMED", "no root cause may rest on it");
  assert.equal(out.claims.find((c: any) => c.id === "R").classification, "HYPOTHESIS");
  // Legacy outputs without provenance still normalize unchanged.
  const legacy = normalizeInvestigationOutput("analysis", { claims: [{ id: "L", claim: "legacy", classification: "HYPOTHESIS" }] });
  assert.equal(legacy.claims[0].provenance, undefined);
});

// ---------------------------------------------------------------- recovery

test("recovery: a rate-limited side-effecting step marked non-retryable is never replayed automatically", () => {
  const ctx = { attempt: 1, maxAttempts: 1, baseBackoff: 5 };
  assert.equal(classifyFailure("Bitbucket 429: too many requests", { ...ctx, executorRetryable: false }).action, "stop");
  assert.equal(classifyFailure("Bitbucket 429: too many requests", ctx).action, "retry", "pure / idempotent work still backs off and retries");
});
