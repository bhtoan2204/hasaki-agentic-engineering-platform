import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeAndPush,
  setMergeModel,
  type ExecutionContext,
  type RunCommand,
} from "../src/workflow/executors/branchMerge.ts";
import type { GoTestReport } from "../src/workflow/executors/baseline.ts";
import type { RunRow, StepRow } from "../src/workflow/types.ts";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const sh = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: ENV }).trim();
const commit = (cwd: string, file: string, content: string, msg: string) => {
  writeFileSync(join(cwd, file), content);
  sh(cwd, "add", file);
  sh(cwd, "commit", "-qm", msg);
  return sh(cwd, "rev-parse", "HEAD");
};
const show = (cwd: string, ref: string, file: string) => sh(cwd, "show", `${ref}:${file}`);

/** origin with release/prod and release/qc (another developer's commit), and a run worktree on `feature`. */
function fixture(
  opts: { qc?: boolean; qcEdit?: [string, string]; baseFiles?: Array<[string, string]> } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "branch-merge-"));
  const origin = join(root, "origin.git"),
    clone = join(root, "clone");
  execFileSync("git", ["init", "-q", "--bare", "-b", "release/prod", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, clone], { env: ENV });
  sh(clone, "checkout", "-qb", "release/prod");
  commit(clone, "a.go", "package a\n\nfunc A() int { return 1 }\n", "base");
  for (const [file, content] of opts.baseFiles ?? []) commit(clone, file, content, `add ${file}`);
  sh(clone, "push", "-q", "origin", "release/prod");
  if (opts.qc !== false) {
    sh(clone, "checkout", "-qb", "release/qc");
    const [file, content] = opts.qcEdit ?? ["other.go", "package a\n\nfunc Other() {}\n"];
    commit(clone, file, content, "someone else's QC change");
    sh(clone, "push", "-q", "origin", "release/qc");
  }
  sh(clone, "checkout", "-qb", "feature", "release/prod");
  commit(clone, "a.go", "package a\n\nfunc A() int { return 2 }\n", "feature change");
  sh(clone, "push", "-q", "origin", "feature");
  return { origin, clone };
}

function context(logs: string[]): ExecutionContext {
  return {
    run: { id: 1, title: "change A" } as RunRow,
    step: { key: "qc_merge", config: { command: "make test" } } as unknown as StepRow,
    input: { upstream: {} },
    signal: new AbortController().signal,
    log: async (_kind, content) => void logs.push(content),
    artifact: async () => 1,
  };
}

const lock = <T>(fn: () => Promise<T>) => fn();
const passing: RunCommand = async () => ({ code: 0, output: "ok", timedOut: false });

test("a clean merge lands on release/qc without touching the feature branch", async () => {
  const { origin, clone } = fixture();
  const featureTip = sh(clone, "rev-parse", "feature");
  let commands = 0;
  const r = await mergeAndPush(
    context([]),
    async () => (commands++, { code: 0, output: "", timedOut: false }),
    { repo: "svc", branch: "feature", path: clone },
    "release/qc",
    lock,
  );
  assert.equal(r.status, "merged");
  assert.deepEqual(r.conflicts, []);
  assert.equal(commands, 0, "clean merges are not re-tested");
  assert.equal(sh(origin, "rev-parse", "release/qc"), r.merge_commit);
  assert.match(show(origin, "release/qc", "a.go"), /return 2/);
  assert.match(show(origin, "release/qc", "other.go"), /Other/);
  assert.equal(sh(origin, "rev-parse", "feature"), featureTip, "the feature branch is unchanged");
  assert.equal(sh(clone, "rev-parse", "feature"), featureTip);
  assert.equal(sh(clone, "worktree", "list").split("\n").length, 1, "scratch worktree removed");

  const again = await mergeAndPush(
    context([]),
    passing,
    { repo: "svc", branch: "feature", path: clone },
    "release/qc",
    lock,
  );
  assert.equal(again.status, "already_merged");
});

test("a repository without release/qc is skipped", async () => {
  const { clone } = fixture({ qc: false });
  const r = await mergeAndPush(
    context([]),
    passing,
    { repo: "svc", branch: "feature", path: clone },
    "release/qc",
    lock,
  );
  assert.equal(r.status, "skipped");
});

test("conflicts are resolved by the model, then built and tested before the push", async () => {
  const { origin, clone } = fixture({
    qcEdit: ["a.go", "package a\n\nfunc A() int { return 3 }\n"],
  });
  const prompts: string[] = [];
  setMergeModel(async (_run, prompt) => {
    prompts.push(prompt);
    return "<<<RESOLVED\npackage a\n\nfunc A() int { return 2 + 3 }\nRESOLVED>>>";
  });
  let runs = 0;
  const r = await mergeAndPush(
    context([]),
    async (_cmd, _cwd, env) => {
      runs++;
      assert.equal(env.BASE_BRANCH, "release/qc");
      return runs === 1
        ? { code: 1, output: "FAIL", timedOut: false }
        : { code: 0, output: "ok", timedOut: false };
    },
    { repo: "svc", branch: "feature", path: clone },
    "release/qc",
    lock,
  );
  assert.equal(r.status, "merged");
  assert.deepEqual(r.conflicts, ["a.go"]);
  assert.equal(r.tested, true);
  assert.equal(runs, 2, "a failing build/test gets one revision round");
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /<<<<<<<.*\n/);
  assert.match(prompts[1], /FAIL/);
  assert.equal(show(origin, "release/qc", "a.go"), "package a\n\nfunc A() int { return 2 + 3 }");
  assert.equal(sh(origin, "rev-list", "--parents", "-n1", "release/qc").split(" ").length, 3);
});

test("a resolution that keeps failing build/test is never pushed", async () => {
  const { origin, clone } = fixture({
    qcEdit: ["a.go", "package a\n\nfunc A() int { return 3 }\n"],
  });
  const before = sh(origin, "rev-parse", "release/qc");
  setMergeModel(async () => "<<<RESOLVED\npackage a\n\nfunc A() int { return 5 }\nRESOLVED>>>");
  await assert.rejects(
    mergeAndPush(
      context([]),
      async () => ({ code: 2, output: "build failed", timedOut: false }),
      { repo: "svc", branch: "feature", path: clone },
      "release/qc",
      lock,
    ),
    /nothing was pushed/,
  );
  assert.equal(sh(origin, "rev-parse", "release/qc"), before);
  assert.equal(sh(clone, "worktree", "list").split("\n").length, 1);
});

test("a reply that still has conflict markers fails the merge", async () => {
  const { origin, clone } = fixture({
    qcEdit: ["a.go", "package a\n\nfunc A() int { return 3 }\n"],
  });
  const before = sh(origin, "rev-parse", "release/qc");
  setMergeModel(async () => "<<<RESOLVED\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> f\nRESOLVED>>>");
  await assert.rejects(
    mergeAndPush(
      context([]),
      passing,
      { repo: "svc", branch: "feature", path: clone },
      "release/qc",
      lock,
    ),
    /conflict markers/,
  );
  assert.equal(sh(origin, "rev-parse", "release/qc"), before);
});

const PKG = "example.com/svc";
const resolveTo = (prompts: string[]) =>
  setMergeModel(async (_run, prompt) => {
    prompts.push(prompt);
    return "<<<RESOLVED\npackage a\n\nfunc A() int { return 2 + 3 }\nRESOLVED>>>";
  });
const goFail = (...tests: string[]) =>
  [...tests.map((t) => `--- FAIL: ${t} (0.00s)`), "FAIL", `FAIL\t${PKG}\t0.010s`].join("\n");
const baselineOf =
  (tests: string[], seen: Array<{ packages: string[]; ref?: string }> = []) =>
  async (_workspace: string, packages: string[], _run: unknown, ref?: string) => {
    seen.push({ packages, ref });
    const report: GoTestReport = {
      [PKG]: { status: tests.length ? "fail" : "ok", tests, buildErrors: [] },
    };
    return { sha: ref ?? "", report, cached: [] };
  };
const conflict = (extra: Array<[string, string]> = []) =>
  fixture({ qcEdit: ["a.go", "package a\n\nfunc A() int { return 3 }\n"], baseFiles: extra });

test("failures that release/qc already has do not block the merge", async () => {
  const { origin, clone } = conflict();
  const qcTip = sh(origin, "rev-parse", "release/qc");
  const prompts: string[] = [];
  resolveTo(prompts);
  const seen: Array<{ packages: string[]; ref?: string }> = [];
  const r = await mergeAndPush(
    context([]),
    async () => ({ code: 1, output: goFail("TestOld"), timedOut: false }),
    { repo: "svc", branch: "feature", path: clone },
    "release/qc",
    lock,
    { baseline: baselineOf(["TestOld"], seen) },
  );
  assert.equal(r.status, "merged");
  assert.deepEqual(r.pre_existing_failures, [`${PKG}: TestOld`]);
  assert.equal(prompts.length, 1, "only the conflict went to the model, no revision round");
  assert.deepEqual(seen, [{ packages: [PKG], ref: qcTip }], "compared on the target tip");
  assert.equal(sh(origin, "rev-parse", "release/qc"), r.merge_commit);
});

test("a failure that release/qc does not have still blocks the merge", async () => {
  const { origin, clone } = conflict();
  const before = sh(origin, "rev-parse", "release/qc");
  const prompts: string[] = [];
  resolveTo(prompts);
  await assert.rejects(
    mergeAndPush(
      context([]),
      async () => ({ code: 1, output: goFail("TestOld", "TestNew"), timedOut: false }),
      { repo: "svc", branch: "feature", path: clone },
      "release/qc",
      lock,
      { baseline: baselineOf(["TestOld"]) },
    ),
    new RegExp(`nothing was pushed.*new failures compared with release/qc: ${PKG}: TestNew`),
  );
  assert.equal(sh(origin, "rev-parse", "release/qc"), before);
  assert.match(prompts[1], /TestNew/);
  assert.doesNotMatch(prompts[1], /TestOld/, "the revision prompt lists only the new failures");
});

test("the revision prompt carries the new failures' test output and test code, not the pre-existing ones", async () => {
  const testFile = 'package a\n\nfunc TestNew(t *testing.T) { expectSpan(t, "use_case") }\n';
  const { clone } = conflict([["a_test.go", testFile]]);
  const prompts: string[] = [];
  resolveTo(prompts);
  await assert.rejects(
    mergeAndPush(
      context([]),
      async (_cmd, cwd) => ({
        code: 1,
        output: [
          "--- FAIL: TestOld (0.00s)",
          "    old_test.go:3: an old, known failure",
          "--- FAIL: TestNew (0.00s)",
          `    controller.go:97: missing call(s) to Generate() ${cwd}/a_test.go:3`,
          "panic: runtime error: invalid memory address or nil pointer dereference",
          "goroutine 10 [running]:",
          `example.com/svc.A() ${cwd}/a.go:3`,
          `FAIL\t${PKG}\t0.010s`,
        ].join("\n"),
        timedOut: false,
      }),
      { repo: "svc", branch: "feature", path: clone },
      "release/qc",
      lock,
      { baseline: baselineOf(["TestOld"]) },
    ),
    /nothing was pushed/,
  );
  assert.match(prompts[1], /missing call\(s\) to Generate\(\)/);
  assert.match(prompts[1], /panic: runtime error/);
  assert.match(prompts[1], /Test code in `a_test.go`[\s\S]*expectSpan\(t, "use_case"\)/);
  assert.doesNotMatch(prompts[1], /an old, known failure/);
});

test("a file without a conflict that a build error points at is revised too (semantic conflict)", async () => {
  const iface = (methods: string) => `package a\n\ntype UseCase interface {\n${methods}}\n`;
  const { origin, clone } = conflict([["iface.go", iface("\tA() int\n")]]);
  sh(clone, "checkout", "-q", "release/qc");
  commit(clone, "iface.go", iface("\tA() int\n\tCancelOrder() error\n"), "qc: new method");
  sh(clone, "push", "-q", "origin", "release/qc");
  sh(clone, "checkout", "-q", "feature");
  const traced =
    "package a\n\ntype traced struct{ next UseCase }\n\nvar _ UseCase = (*traced)(nil)\n\nfunc (t *traced) A() int { return t.next.A() }\n";
  commit(clone, "traced.go", traced, "feature: tracing decorator");
  sh(clone, "push", "-q", "origin", "feature");
  const prompts: string[] = [];
  setMergeModel(async (_run, prompt) => {
    prompts.push(prompt);
    if (prompt.includes("Current traced.go"))
      return `<<<RESOLVED\n${traced}\nfunc (t *traced) CancelOrder() error { return t.next.CancelOrder() }\nRESOLVED>>>`;
    return "<<<RESOLVED\npackage a\n\nfunc A() int { return 2 + 3 }\nRESOLVED>>>";
  });
  const r = await mergeAndPush(
    context([]),
    async (_cmd, cwd) => {
      return readFileSync(join(cwd, "traced.go"), "utf8").includes("CancelOrder")
        ? { code: 0, output: "ok", timedOut: false }
        : {
            code: 1,
            output: `# ${PKG}\ntraced.go:5:17: cannot use (*traced)(nil) (value of type *traced) as UseCase value in variable declaration: *traced does not implement UseCase (missing method CancelOrder)\nFAIL\t${PKG} [build failed]`,
            timedOut: false,
          };
    },
    { repo: "svc", branch: "feature", path: clone },
    "release/qc",
    lock,
    { baseline: baselineOf([]) },
  );
  assert.equal(r.status, "merged");
  const revision = prompts.find((p) => p.includes("Current traced.go"))!;
  assert.match(revision, /had no conflict, but the merge brings it in/);
  assert.match(
    revision,
    /iface\.go:\d+:\s*CancelOrder\(\) error/,
    "the missing method's declaration is shown",
  );
  assert.match(show(origin, "release/qc", "traced.go"), /func \(t \*traced\) CancelOrder\(\)/);
  assert.deepEqual(r.conflicts, ["a.go"]);
});

test("stale mocks are regenerated and kept when that makes the tests pass", async () => {
  const gen = "package a\n\n//go:generate mockgen -source=a.go -destination=a_mock.go -package=a\n";
  const { origin, clone } = conflict([["gen.go", gen]]);
  const prompts: string[] = [];
  resolveTo(prompts);
  const commands: string[] = [];
  const r = await mergeAndPush(
    context([]),
    async (cmd, cwd) => {
      commands.push(cmd);
      if (cmd.startsWith("go generate")) {
        writeFileSync(join(cwd, "a_mock.go"), "package a\n// regenerated\n");
        return { code: 0, output: "", timedOut: false };
      }
      return existsSync(join(cwd, "a_mock.go"))
        ? { code: 0, output: "ok", timedOut: false }
        : { code: 1, output: goFail("TestStale"), timedOut: false };
    },
    { repo: "svc", branch: "feature", path: clone },
    "release/qc",
    lock,
    { baseline: baselineOf([]) },
  );
  assert.equal(r.status, "merged");
  assert.deepEqual(r.regenerated_mocks, ["a_mock.go"]);
  assert.ok(commands.includes("go generate -run mockgen ."));
  assert.equal(prompts.length, 1, "no model revision was needed");
  assert.match(show(origin, "release/qc", "a_mock.go"), /regenerated/);
  assert.equal(sh(origin, "rev-list", "--parents", "-n1", "release/qc").split(" ").length, 3);
});

test("regenerated mocks that do not fix the failure are discarded", async () => {
  const gen = "package a\n\n//go:generate mockgen -source=a.go -destination=a_mock.go -package=a\n";
  const { origin, clone } = conflict([["gen.go", gen]]);
  const before = sh(origin, "rev-parse", "release/qc");
  resolveTo([]);
  const mockPresent: boolean[] = [];
  await assert.rejects(
    mergeAndPush(
      context([]),
      async (cmd, cwd) => {
        if (cmd.startsWith("go generate")) {
          writeFileSync(join(cwd, "a_mock.go"), "package a\n// regenerated\n");
          return { code: 0, output: "", timedOut: false };
        }
        mockPresent.push(existsSync(join(cwd, "a_mock.go")));
        return { code: 1, output: goFail("TestStale"), timedOut: false };
      },
      { repo: "svc", branch: "feature", path: clone },
      "release/qc",
      lock,
      { baseline: baselineOf([]) },
    ),
    /nothing was pushed/,
  );
  assert.deepEqual(
    mockPresent,
    [false, true, false, false],
    "tree restored after the regen attempt",
  );
  assert.equal(sh(origin, "rev-parse", "release/qc"), before);
  assert.equal(sh(clone, "worktree", "list").split("\n").length, 1);
});
