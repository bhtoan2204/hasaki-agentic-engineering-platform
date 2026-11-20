import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeAndPush,
  setMergeModel,
  type ExecutionContext,
  type RunCommand,
} from "../src/workflow/executors/branchMerge.ts";
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
function fixture(opts: { qc?: boolean; qcEdit?: [string, string] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "branch-merge-"));
  const origin = join(root, "origin.git"),
    clone = join(root, "clone");
  execFileSync("git", ["init", "-q", "--bare", "-b", "release/prod", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, clone], { env: ENV });
  sh(clone, "checkout", "-qb", "release/prod");
  commit(clone, "a.go", "package a\n\nfunc A() int { return 1 }\n", "base");
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
