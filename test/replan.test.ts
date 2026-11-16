import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideFeedbackRoute,
  feedbackSignals,
  heuristicJudgement,
  parseJudgement,
  replanAnchors,
  routeFromJudgement,
  routeTargets,
} from "../src/workflow/replan.ts";
import { TEMPLATES } from "../src/workflow/templates.ts";
import { snapshotUncommitted } from "../src/git.ts";

const graphOf = (key: string) => TEMPLATES.find((t) => t.key === key)!.spec as any;
const withDefaults = (g: any) => ({
  ...g,
  steps: g.steps.map((s: any) => ({ depends_on: [], config: {}, ...s })),
});

test("replan anchors come from the graph: coding step, planning after repository selection, discovery, roots", () => {
  const bug = withDefaults(graphOf("bug-investigation"));
  assert.deepEqual(replanAnchors(bug), {
    reimplement: "implement",
    replan: "root_cause",
    rediscover: "discover",
    restart: ["analyze"],
  });
  const feature = withDefaults(graphOf("feature-implementation"));
  assert.equal(replanAnchors(feature).replan, "plan");
  // without replan_step the anchor is derived: first agent step after the repository selection
  const { replan_step, ...derived } = feature;
  assert.equal(replan_step, "plan");
  assert.equal(replanAnchors(derived).replan, "plan");
  // a graph without discovery: rediscover falls back to the broader restart
  const tiny = withDefaults({
    steps: [
      { key: "a", type: "agent" },
      { key: "b", type: "coding_agent", depends_on: ["a"] },
    ],
  });
  assert.deepEqual(routeTargets(tiny, "rediscover"), { route: "restart", targets: ["a"] });
  assert.deepEqual(routeTargets(tiny, "replan"), { route: "replan", targets: ["a"] });
});

test("judgement flags widen the route; a narrow model answer cannot hide a scope or design change", () => {
  assert.equal(routeFromJudgement({ route: "reimplement" }), "reimplement");
  assert.equal(routeFromJudgement({ route: "reimplement", architecture_change: true }), "replan");
  assert.equal(routeFromJudgement({ route: "replan", scope_change: true }), "rediscover");
  assert.equal(
    routeFromJudgement({ route: "replan", scope_change: true, architecture_change: true }),
    "restart",
  );
  assert.equal(routeFromJudgement({ route: "reimplement", full_review: true }), "restart");
});

test("auto routing combines the model judgement with the deterministic repository signal", () => {
  const signals = feedbackSignals(
    "Thiết kế chưa generic và thiếu oms-frontend",
    ["oms-api", "oms-frontend", "oms-background"],
    ["oms-api"],
  );
  assert.deepEqual(signals.unselected_repositories, ["oms-frontend"]);
  // the model only saw a design problem; the named repository widens it to a full replan
  const d = decideFeedbackRoute({
    mode: "auto",
    signals,
    judgement: { route: "replan", architecture_change: true, reasons: ["per-marketplace copy"] },
  });
  assert.equal(d.route, "restart");
  assert.equal(d.source, "model");
  assert.match(d.reasons.join(" "), /outside the selection: oms-frontend/);
  // a selected repository named in a small fix is not a scope change
  assert.deepEqual(
    feedbackSignals("oms-api: rename field", ["oms-api", "oms-frontend"], ["oms-api"])
      .unselected_repositories,
    [],
  );
  // an explicit mode is the developer's call
  const manual = decideFeedbackRoute({ mode: "reimplement", signals });
  assert.equal(manual.route, "reimplement");
  assert.equal(manual.source, "developer");
});

test("fallback cues apply only without a model; small fixes stay on the coding step", () => {
  assert.equal(heuristicJudgement("đổi tên biến cho đúng convention").route, "reimplement");
  assert.equal(heuristicJudgement("refactor lại theo kiến trúc dùng chung").route, "replan");
  assert.equal(heuristicJudgement("review lại toàn bộ task này").route, "restart");
  const d = decideFeedbackRoute({
    mode: "auto",
    signals: { unselected_repositories: [] },
    judgement: null,
    fallback: heuristicJudgement("fix typo in log message"),
  });
  assert.equal(d.route, "reimplement");
  assert.equal(d.source, "heuristic");
});

test("model replies are parsed strictly", () => {
  assert.equal(parseJudgement("no json"), null);
  assert.equal(parseJudgement('{"route":"delete-everything"}'), null);
  assert.deepEqual(
    parseJudgement(
      'ok: {"route":"replan","architecture_change":true,"confidence":0.8,"reasons":["x"]}',
    ),
    {
      route: "replan",
      architecture_change: true,
      scope_change: false,
      requirement_change: false,
      full_review: false,
      confidence: 0.8,
      reasons: ["x"],
    },
  );
});

test("uncommitted work is snapshotted to a ref without touching the worktree, index or branch", async () => {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const g = (cwd: string, ...a: string[]) =>
    execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env }).trim();
  const path = mkdtempSync(join(tmpdir(), "snap-"));
  g(path, "init", "-q", "-b", "feature");
  writeFileSync(join(path, "a.go"), "v1\n");
  g(path, "add", "-A");
  g(path, "commit", "-qm", "base");
  const head = g(path, "rev-parse", "HEAD");
  assert.equal(await snapshotUncommitted(path, "refs/platform/replan/t/1", "m"), null, "clean");

  writeFileSync(join(path, "a.go"), "v2 staged\n");
  g(path, "add", "a.go");
  writeFileSync(join(path, "a.go"), "v3 unstaged\n");
  writeFileSync(join(path, "new.go"), "untracked\n");
  const before = g(path, "status", "--porcelain");
  const snap = await snapshotUncommitted(path, "refs/platform/replan/t/1", "before replan");
  assert.ok(snap);
  assert.equal(g(path, "status", "--porcelain"), before, "worktree and index unchanged");
  assert.equal(g(path, "rev-parse", "HEAD"), head, "branch unchanged");
  assert.equal(g(path, "show", `${snap.commit}:a.go`), "v3 unstaged");
  assert.equal(g(path, "show", `${snap.commit}:new.go`), "untracked");
  assert.equal(g(path, "rev-parse", "refs/platform/replan/t/1"), snap.commit);
  assert.equal(readFileSync(join(path, "a.go"), "utf8"), "v3 unstaged\n");
  await assert.rejects(snapshotUncommitted(path, "refs/heads/feature", "m"), /refs\/platform/);
});
