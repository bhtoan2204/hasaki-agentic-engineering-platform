import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  EvidenceCache,
  memoryEvidenceStore,
  evidenceKey,
  notReusableReason,
} from "../src/agent/verifyEvidence.ts";
import {
  verifyConfig,
  verifyWorkspaces,
  type RepoVerification,
  type VerifyDeps,
} from "../src/agent/verify.ts";

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, ...a], { stdio: "pipe" }).toString();

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "evidence-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  await writeFile(join(dir, "a.txt"), "1");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function setup(
  dir: string,
  store = memoryEvidenceStore(),
  opts: { code?: number; delay?: number; contract?: string; command?: string } = {},
) {
  let calls = 0;
  const logs: string[] = [];
  const mk = (scope = { runId: 1, stepKey: "implement", attemptId: 7 }) =>
    new EvidenceCache(store, scope);
  let cfg = {
    ...verifyConfig({ verify: { command: opts.command ?? "true" } }, "true")!,
    baseline: null as null,
    contractRevision: opts.contract ?? "c1",
  };
  const deps = (cache?: EvidenceCache): VerifyDeps => ({
    run: async () => {
      calls++;
      if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
      return { code: opts.code ?? 0, output: "ok", timedOut: false };
    },
    log: (t) => void logs.push(t),
    ...(cache ? { evidence: cache } : {}),
  });
  const go = (c: typeof cfg, cache?: EvidenceCache, env = {}) =>
    verifyWorkspaces(
      [{ repo: "r", path: dir }],
      [dir],
      c,
      1,
      new AbortController().signal,
      deps(cache),
      env,
    );
  return {
    get cfg() {
      return cfg;
    },
    set cfg(v) {
      cfg = v;
    },
    go,
    mk,
    calls: () => calls,
    logs,
    store,
  };
}

test("second identical request reuses the pass and records a hit", async () => {
  const dir = await repo();
  const t = setup(dir);
  const cache = t.mk();
  const r1 = await t.go(t.cfg, cache);
  const r2 = await t.go(t.cfg, cache);
  assert.equal(t.calls(), 1);
  assert.equal(r1.passed && r2.passed, true);
  assert.equal(r2.repos[0].evidence?.reused, true);
  assert.equal(cache.stats.hits, 1);
  assert.equal(cache.stats.misses, 1);
  assert.ok(t.logs.some((l) => l.includes("reused evidence")));
  await rm(dir, { recursive: true });
});

test("no evidence dep: always runs (backward compatible)", async () => {
  const dir = await repo();
  const t = setup(dir);
  await t.go(t.cfg);
  await t.go(t.cfg);
  assert.equal(t.calls(), 2);
  await rm(dir, { recursive: true });
});

test("every key part change is a miss with the matching reason", async () => {
  const dir = await repo();
  const t = setup(dir);
  const cache = t.mk();
  await t.go(t.cfg, cache);
  const reasons = () => cache.stats.invalidations.at(-1);
  // Each step changes exactly one part relative to the latest stored evidence.
  let c = { ...t.cfg, contractRevision: "c2" };
  await t.go(c, cache);
  assert.equal(reasons(), "contract_revision");
  c = { ...c, command: "true #2" };
  await t.go(c, cache);
  assert.equal(reasons(), "command");
  c = { ...c, allowTestWeakening: true };
  await t.go(c, cache);
  assert.equal(reasons(), "policy");
  c = { ...c, timeoutMs: 99000 };
  await t.go(c, cache);
  assert.equal(reasons(), "timeout");
  await t.go(c, cache, { RUN_ID: "9" });
  assert.equal(reasons(), "env_vars");
  t.cfg = c;
  await writeFile(join(dir, "untracked.txt"), "x");
  await t.go(t.cfg, cache, { RUN_ID: "9" });
  assert.equal(reasons(), "workspace_fingerprint");
  await writeFile(join(dir, "package.json"), "{}");
  await t.go(t.cfg, cache, { RUN_ID: "9" });
  assert.equal(reasons(), "workspace_fingerprint"); // untracked dep file also changes the fingerprint
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "two");
  await t.go(t.cfg, cache, { RUN_ID: "9" });
  assert.equal(reasons(), "head");
  assert.equal(t.calls(), 9);
  await rm(dir, { recursive: true });
});

test("dependency file edit that keeps HEAD/fingerprint equal cannot be hidden: env fingerprint differs", async () => {
  const dir = await repo();
  const t = setup(dir);
  const cache = t.mk();
  await writeFile(join(dir, "go.mod"), "module a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "go");
  await t.go(t.cfg, cache);
  await writeFile(join(dir, "go.mod"), "module b\n");
  await t.go(t.cfg, cache);
  assert.equal(t.calls(), 2);
  await rm(dir, { recursive: true });
});

test("failed results are never stored or reused", async () => {
  const dir = await repo();
  const t = setup(dir, undefined, { code: 1 });
  const cache = t.mk();
  const r1 = await t.go(t.cfg, cache);
  await t.go(t.cfg, cache);
  assert.equal(r1.passed, false);
  assert.equal(t.calls(), 2);
  assert.equal(t.store.rows.length, 0);
  assert.ok(cache.stats.not_stored.length >= 1);
  await rm(dir, { recursive: true });
});

test("notReusableReason rejects every non-clean state", () => {
  const base = {
    status: "passed" as const,
    passed: true,
    exit_code: 0,
    timed_out: false,
    weakened: [],
    needs_review: false,
    tested_state: { head: "h", fingerprint: "f" },
  } as unknown as RepoVerification;
  assert.equal(notReusableReason(base), null);
  const bads: Array<Partial<RepoVerification>> = [
    { status: "failed" },
    { status: "error" },
    { status: "skipped" },
    { timed_out: true },
    { exit_code: 1 },
    { needs_review: true },
    { status: "accepted_preexisting", needs_review: true },
    { weakened: ["x"] },
    { error: "e" },
    { tested_state: undefined },
  ];
  for (const bad of bads) assert.ok(notReusableReason({ ...base, ...bad }), JSON.stringify(bad));
});

test("10 concurrent identical requests run once; map empties", async () => {
  const dir = await repo();
  const t = setup(dir, undefined, { delay: 30 });
  const cache = t.mk();
  const res = await Promise.all(Array.from({ length: 10 }, () => t.go(t.cfg, cache)));
  assert.equal(t.calls(), 1);
  assert.ok(res.every((r) => r.passed));
  // A follower whose key is computed after the leader finished gets a stored hit instead of joining the flight.
  assert.equal(cache.stats.duplicates_avoided + cache.stats.hits, 9);
  assert.equal(cache.pending, 0);
  await rm(dir, { recursive: true });
});

test("leader failure is not cached; next request reruns", async () => {
  const dir = await repo();
  const store = memoryEvidenceStore();
  const cache = new EvidenceCache(store, { runId: 1, stepKey: "s" });
  let n = 0;
  const cfg = { ...verifyConfig({ verify: { command: "true" } }, "true")!, baseline: null as null };
  const deps = (fail: boolean): VerifyDeps => ({
    run: async () => {
      n++;
      await new Promise((r) => setTimeout(r, 20));
      if (fail) throw new Error("boom");
      return { code: 0, output: "", timedOut: false };
    },
    evidence: cache,
  });
  const sig = new AbortController().signal;
  const ws = [{ repo: "r", path: dir }];
  const [a, b] = await Promise.allSettled([
    verifyWorkspaces(ws, [dir], cfg, 1, sig, deps(true)),
    verifyWorkspaces(ws, [dir], cfg, 1, sig, deps(true)),
  ]);
  assert.equal(a.status, "rejected");
  assert.equal(b.status === "rejected" || (b.status === "fulfilled" && n === 2), true);
  assert.equal(cache.pending, 0);
  assert.equal(store.rows.length, 0);
  const ok = await verifyWorkspaces(ws, [dir], cfg, 1, sig, deps(false));
  assert.equal(ok.passed, true);
  await rm(dir, { recursive: true });
});

test("new process (new cache, same store) hits; other run and other contract do not share", async () => {
  const dir = await repo();
  const store = memoryEvidenceStore();
  const t = setup(dir, store);
  await t.go(t.cfg, t.mk());
  await t.go(t.cfg, t.mk());
  assert.equal(t.calls(), 1);
  await t.go(t.cfg, t.mk({ runId: 2, stepKey: "implement", attemptId: 8 }));
  assert.equal(t.calls(), 2);
  await t.go({ ...t.cfg, contractRevision: "other" }, t.mk());
  assert.equal(t.calls(), 3);
  await rm(dir, { recursive: true });
});

test("a failing store means a rerun, never a false pass", async () => {
  const dir = await repo();
  const broken = {
    find: async () => {
      throw new Error("db down");
    },
    latest: async () => null,
    save: async () => {
      throw new Error("db down");
    },
  };
  const cache = new EvidenceCache(broken, { runId: 1, stepKey: "s" });
  const t = setup(dir);
  const r = await t.go(t.cfg, cache);
  await t.go(t.cfg, cache);
  assert.equal(r.passed, true);
  assert.equal(t.calls(), 2);
  await rm(dir, { recursive: true });
});

test("evidenceKey is order independent", () => {
  assert.equal(evidenceKey({ a: "1", b: "2" }), evidenceKey({ b: "2", a: "1" }));
  assert.notEqual(evidenceKey({ a: "1" }), evidenceKey({ a: "2" }));
});
