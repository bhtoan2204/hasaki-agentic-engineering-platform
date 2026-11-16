import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectedSkills, injectSkills, deriveSkillActivation } from "../src/agent/skillTracing.ts";
import { detectNativeKnowledgeSources } from "../src/knowledge/nativeSources.ts";
import type { ResolvedContext } from "../src/workflow/context.ts";

function fixture(tier: "inline" | "index" | "search") {
  const knowledge: ResolvedContext["knowledge"] = [
    {
      key: "ponytail",
      title: "Ponytail",
      category: "agent_skill",
      scope_type: "GLOBAL",
      scope_ref: "",
      conflict_key: null,
      priority: 0,
      enforced: false,
      version: 2,
      content: "reuse existing code",
      applicability: {},
      metadata: {},
      reason: "assigned to step",
    },
  ];
  return {
    knowledge,
    disclosure: [{ key: "ponytail", disclosure: tier, score: 0, tokens: 5, why: "fixture" }],
    overridden: [],
  };
}
test("skill tracing distinguishes selection and injection from activation", () => {
  const ctx = fixture("inline");
  const traces = selectedSkills(ctx);
  assert.equal(traces[0].state, "selected");
  injectSkills(traces, ctx);
  const unused = deriveSkillActivation(traces, ctx.knowledge, [], []);
  assert.deepEqual(unused[0].states, ["selected", "injected"]);
  assert.equal(unused[0].loaded_unused, true);
  const active = deriveSkillActivation(traces, ctx.knowledge, [], ["ponytail"]);
  assert.equal(active[0].state, "activated");
  assert.equal(active[0].loaded_unused, false);
});
test("index skill activation requires complete version-matched body reads and declaration", () => {
  const ctx = fixture("index");
  const traces = selectedSkills(ctx);
  injectSkills(traces, ctx);
  const first = { key: "ponytail", version: 2, offset: 0, end: 5 };
  assert.equal(
    deriveSkillActivation(traces, ctx.knowledge, [first], ["ponytail"])[0].state,
    "injected",
  );
  const reads = [first, { ...first, offset: 5, end: ctx.knowledge[0].content.length }];
  assert.equal(deriveSkillActivation(traces, ctx.knowledge, reads, [])[0].state, "loaded");
  assert.equal(deriveSkillActivation(traces, ctx.knowledge, reads, [])[0].loaded_unused, true);
  const active = deriveSkillActivation(traces, ctx.knowledge, reads, ["ponytail"])[0];
  assert.deepEqual(active.states, ["selected", "injected", "loaded", "activated"]);
  assert.deepEqual(active.evidence, [
    "read_knowledge:complete_body",
    "submit_result:skills_applied",
  ]);
  assert.equal(
    deriveSkillActivation(
      traces,
      ctx.knowledge,
      reads.map((r) => ({ ...r, version: 1 })),
      ["ponytail"],
    )[0].state,
    "injected",
  );
});
test("search skills load without injection; provider limitations cannot activate", () => {
  const ctx = fixture("search");
  const traces = selectedSkills(ctx);
  injectSkills(traces, ctx);
  assert.equal(traces[0].state, "selected");
  const reads = [{ key: "ponytail", version: 2, offset: 0, end: ctx.knowledge[0].content.length }];
  assert.equal(
    deriveSkillActivation(traces, ctx.knowledge, reads, ["ponytail"])[0].state,
    "activated",
  );
  const limited = selectedSkills({
    ...ctx,
    knowledge: [],
    overridden: [
      {
        key: "ponytail",
        version: 2,
        reason: "unavailable",
        by: "",
        conflict_key: "",
        detail: "unsupported provider",
      },
    ],
  });
  assert.equal(
    deriveSkillActivation(limited, ctx.knowledge, reads, ["ponytail"])[0].provider_limited,
    true,
  );
  assert.equal(limited[0].state, "selected");
});
test("native knowledge snapshots record hashes without content and exclude escaping symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-sources-"));
  try {
    await mkdir(join(root, ".cursor/rules"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "PRIVATE_NATIVE_RULE");
    await writeFile(join(root, ".cursor/rules/policy.mdc"), "cursor policy");
    await symlink("/etc/passwd", join(root, ".cursor/rules/escape.mdc"));
    const sources = await detectNativeKnowledgeSources([{ repo: "fixture", path: root }]);
    assert.equal(sources.length, 2);
    assert.ok(sources.every((s) => /^[a-f0-9]{64}$/.test(s.sha256)));
    assert.ok(!JSON.stringify(sources).includes("PRIVATE_NATIVE_RULE"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coding and analysis bridges advertise structured skill declarations", async () => {
  const { bridgeToolsFor } = await import("../src/agent/mcpBridge.ts");
  for (const mode of ["coding", "analysis"]) {
    const submit = bridgeToolsFor(mode).find((tool) => tool.name === "submit_result");
    assert.ok(submit, mode);
    const schema = submit.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    assert.deepEqual(schema.properties.skills_applied, {
      type: "array",
      items: { type: "string" },
    });
    assert.ok(!schema.required.includes("skills_applied"), "legacy submissions stay compatible");
  }
});
