import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyProfile,
  classifyProfile,
  ProfileNotApplicable,
  type ProfileSignals,
} from "../src/workflow/profiles.ts";
import { TEMPLATES } from "../src/workflow/templates.ts";
import { validateSpec, topoOrder } from "../src/workflow/graph.ts";

const sig = (over: Partial<ProfileSignals> = {}): ProfileSignals => ({
  title: "",
  description: "",
  project: "OMS",
  repositories: [],
  knownRepository: null,
  matchingRepositories: 0,
  ...over,
});
const tpl = (k: string) => validateSpec(TEMPLATES.find((t) => t.key === k)!.spec);

test("profile: one-field mapping bug in a known repository → FAST with reasons", () => {
  const d = classifyProfile(
    sig({
      title: "[Bug] Thiếu ZIP Code đơn Ecom US",
      description: "postal_code mapping bị mất khi Ecom gửi ZIP+4",
      knownRepository: "inside-product-worker-usa",
      matchingRepositories: 1,
    }),
  );
  assert.equal(d.profile, "FAST");
  assert.equal(d.confidence, "medium");
  assert.ok(d.reasons.some((r) => r.includes("inside-product-worker-usa")));
});

test("profile: normalization/whitespace bug in an explicitly selected repo → FAST (high confidence)", () => {
  const d = classifyProfile(
    sig({
      title: "[Bug] Tên khách hàng không được chuẩn hoá khoảng trắng",
      repositories: ["ecom-mapper"],
    }),
  );
  assert.equal(d.profile, "FAST");
  assert.equal(d.confidence, "high");
});

test("profile: short description alone is not FAST; unknown repo falls back to STANDARD", () => {
  assert.equal(classifyProfile(sig({ title: "Fix bug" })).profile, "STANDARD");
  const d = classifyProfile(sig({ title: "[Bug] Sai format postal code", description: "" }));
  assert.equal(d.profile, "STANDARD");
  assert.equal(d.confidence, "low");
  assert.ok(d.reasons.some((r) => /not known/.test(r)));
});

test("profile: payment, migration, security, distributed transactions are never FAST automatically", () => {
  for (const title of [
    "[Bug] Refund amount mapping sai",
    "[Bug] Lỗi đối soát COD field",
    "Fix migration for postal field",
    "Fix auth token field mapping",
    "[Bug] Thiếu field trong outbox event",
    "[Bug] Sai trường thanh toán",
  ]) {
    const d = classifyProfile(sig({ title, repositories: ["oms-api"] }));
    assert.notEqual(d.profile, "FAST", title);
    assert.ok(
      d.reasons.some((r) => /high-risk/.test(r)),
      title,
    );
  }
});

test("profile: multi-repo, epics and declared high risk → DEEP; manual override wins (with a warning when risky)", () => {
  assert.equal(
    classifyProfile(
      sig({ title: "[Bug] field mapping", repositories: ["oms-api", "oms-background"] }),
    ).profile,
    "DEEP",
  );
  assert.equal(classifyProfile(sig({ title: "[EPIC] Tiktok US" })).profile, "DEEP");
  assert.equal(
    classifyProfile(sig({ title: "[Bug] typo", repositories: ["oms-api"], declaredRisk: "high" }))
      .profile,
    "DEEP",
  );
  const forced = classifyProfile(sig({ title: "Refund mapping" }), "FAST");
  assert.equal(forced.profile, "FAST");
  assert.ok(forced.warnings.some((w) => /high-risk/.test(w)));
  assert.equal(
    classifyProfile(sig({ title: "[Bug] Thiếu ZIP Code", repositories: ["x"] }), "STANDARD")
      .profile,
    "STANDARD",
  );
});

test("FAST DAG: analysis folded into the coding step, plan approval and AI review removed, tests/PR kept, valid DAG", () => {
  const spec = tpl("feature-implementation");
  const { spec: fast, changes } = applyProfile(spec, "FAST");
  const keys = fast.steps.map((s) => s.key);
  assert.deepEqual(keys, ["discover", "confirm_repos", "implement", "test", "pr"]);
  assert.equal(new Set(keys).size, keys.length, "no duplicated steps");
  const impl = fast.steps.find((s) => s.key === "implement")!;
  assert.deepEqual(impl.config.merged_from, ["analyze", "plan"]);
  assert.match(String(impl.config.instructions), /Requirement Analysis/);
  assert.deepEqual(impl.depends_on, ["confirm_repos"]);
  assert.deepEqual(
    fast.steps.find((s) => s.key === "pr")!.depends_on,
    ["test"],
    "review removed, PR rewired to tests",
  );
  assert.equal(
    fast.steps.find((s) => s.key === "pr")!.config.mode,
    "approval",
    "PR approval preserved",
  );
  assert.equal(fast.steps.find((s) => s.key === "discover")!.config.use_ai, false);
  assert.equal(
    fast.steps.find((s) => s.key === "confirm_repos")!.config.auto_approve_unambiguous,
    true,
  );
  assert.doesNotThrow(() => validateSpec({ ...fast }));
  assert.doesNotThrow(() => topoOrder(fast.steps));
  assert.ok(changes.some((c) => c.step === "approve_plan" && c.action === "removed"));
  assert.ok(changes.some((c) => c.step === "review" && c.action === "removed"));
  assert.ok(
    !spec.steps.find((s) => s.key === "implement")!.config.merged_from,
    "published spec untouched",
  );
  const bug = applyProfile(tpl("bug-investigation"), "FAST").spec;
  assert.deepEqual(bug.steps.find((s) => s.key === "implement")!.config.merged_from, [
    "analyze",
    "root_cause",
    "fix_proposal",
  ]);
  assert.deepEqual(
    bug.steps.map((s) => s.key),
    ["discover", "confirm_repos", "implement", "regression_test", "pr"],
  );
});

test("FAST not applicable: no coding step, or a branch depends on a removed step → caller falls back", () => {
  assert.throws(() => applyProfile(tpl("code-review"), "FAST"), ProfileNotApplicable);
  const spec = validateSpec({
    name: "x",
    steps: [
      { key: "analyze", type: "agent" },
      {
        key: "check",
        type: "condition",
        depends_on: ["analyze"],
        config: { path: "upstream.analyze.output.risky", op: "truthy" },
      },
      { key: "implement", type: "coding_agent", depends_on: ["check"] },
    ],
  });
  assert.throws(() => applyProfile(spec, "FAST"), /reads the output/);
});

test("STANDARD is the identity; DEEP removes auto-approval and enables AI discovery", () => {
  const spec = tpl("bug-investigation");
  assert.deepEqual(
    spec.steps.find((s) => s.key === "pr")!.depends_on,
    ["review"],
    "bug fixes are code-reviewed before the PR",
  );
  assert.equal(applyProfile(spec, "STANDARD").spec, spec);
  const deep = applyProfile(spec, "DEEP");
  assert.equal(
    deep.spec.steps.find((s) => s.key === "confirm_repos")!.config.auto_approve_unambiguous,
    undefined,
  );
  assert.ok(deep.changes.length >= 1);
  assert.equal(deep.spec.steps.length, spec.steps.length);
});
