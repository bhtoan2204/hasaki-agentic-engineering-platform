import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { planExternalSkills } from "../src/knowledge/externalImport.ts";
import {
  resolveKnowledge,
  PRECEDENCE_STATEMENT,
  type KnowledgeCandidate,
} from "../src/knowledge/resolve.ts";
import { planKnowledge } from "../src/context/plan.ts";
import { buildSystemAppend } from "../src/agent/stepPrompt.ts";
import { source } from "../src/agent/contextTools.ts";
import { pool } from "../src/db/pool.ts";
import type { ResolvedContext } from "../src/workflow/context.ts";
import type { RunRow, StepRow } from "../src/workflow/types.ts";
import type { ContextPack } from "../src/context/pack.ts";

after(() => pool.end());

test("Ponytail prompt snapshots expose equivalent skills and one precedence statement on all providers", () => {
  const root = fileURLToPath(new URL("../skills/external/", import.meta.url));
  const imported = planExternalSkills(root);
  assert.ok(!imported.rejected.some((r) => r.key.startsWith("skill.ext.ponytail")));
  const candidates: KnowledgeCandidate[] = imported.candidates
    .filter((k) => k.key.startsWith("skill.ext.ponytail"))
    .map((k) => ({
      ...k,
      category: "agent_skill",
      scope_type: "GLOBAL",
      scope_ref: k.scope_ref ?? "",
      conflict_key: k.conflict_key ?? null,
      enforced: k.enforced ?? false,
      priority: k.priority ?? 0,
      version: 1,
      applicability: k.applicability ?? {},
      metadata: k.metadata ?? {},
    }));
  assert.equal(candidates.length, 2);
  for (const role of ["implement", "review"] as const) {
    const key = role === "implement" ? "skill.ext.ponytail" : "skill.ext.ponytail-review";
    const stepType = role === "implement" ? "coding_agent" : "agent";
    const resolved = resolveKnowledge(candidates, {
      organization: "fixture",
      project: "fixture",
      repositories: ["fixture"],
      workflowKey: "ponytail-nonproduction-pilot",
      stepKey: role,
      stepType,
      text: "Apply minimal changes and review their safety",
      explicit: [key],
      ponytailEnabled: false,
    });
    assert.deepEqual(
      resolved.applied.map((k) => k.key),
      [key],
    );
    const base: ResolvedContext = {
      snapshot_id: 1,
      hash: "fixture",
      project: "fixture",
      repositories: ["fixture"],
      knowledge: resolved.applied,
      overridden: resolved.overridden,
      disclosure: planKnowledge(resolved.applied, {
        requestText: "fixture",
        stepType,
        inlineTokens: 8000,
        indexSize: 12,
      }),
      upstream: { plan: {}, text: {} },
      requestText: "fixture",
      fileRefs: [],
    };
    const pack: ContextPack = {
      version: 1,
      run_id: 1,
      step_id: 1,
      attempt_id: 1,
      owner_id: 1,
      snapshot_id: 1,
      created_at: "2026-11-13T00:00:00.000Z",
      budget_tokens: 20000,
      estimated_tokens: 2000,
      token_measurement: "character_estimate_not_provider_usage",
      entries: resolved.applied.map((k) => ({
        id: `knowledge:${k.key}:v${k.version}`,
        section: "knowledge",
        trust: "curated_rule",
        required: true,
        priority: 990,
        body: JSON.stringify({ key: k.key, content: k.content }),
        provenance: source(
          k.key,
          k.version,
          "2026-11-13T00:00:00.000Z",
          "shared",
          "explicit pilot",
        ),
      })),
      omitted: [],
      parent_pack_ids: [],
      retrieval_calls: 0,
      retrieval_failures: 0,
      preparation_ms: 0,
    };
    for (const packed of [false, true]) {
      let snapshot: string | undefined;
      for (const provider of ["claude", "codex", "cursor", "antigravity"] as const) {
        const run = {
          id: 1,
          definition_key: "ponytail-nonproduction-pilot",
          branch: "pilot",
          allowed_repositories: ["fixture"],
          selected_repositories: ["fixture"],
          agent_provider: provider,
          output_locale: "en",
        } as RunRow;
        const step = {
          id: 1,
          key: role,
          name: role,
          type: stepType,
          config: { skills: [key] },
        } as unknown as StepRow;
        const prompt = buildSystemAppend(
          run,
          step,
          { ...base, ...(packed ? { contextPack: pack } : {}) },
          role === "implement" ? "coding" : "analysis",
        );
        assert.equal(prompt.split(PRECEDENCE_STATEMENT).length - 1, 1, provider);
        assert.match(prompt, new RegExp(key.replaceAll(".", "\\.")));
        assert.ok(
          !prompt.includes(
            role === "implement" ? "skill.ext.ponytail-review" : '"skill.ext.ponytail"',
          ),
        );
        assert.ok(
          prompt.includes(
            packed ? JSON.stringify(pack.entries[0].body) : resolved.applied[0].content,
          ),
          `${provider} includes the adapted body`,
        );
        assert.match(prompt, /Tests and verification (?:are|remain) governed by/);
        assert.match(prompt, /skills_applied/);
        snapshot ??= prompt;
        assert.equal(
          prompt,
          snapshot,
          `${role} ${packed ? "pack" : "inline"} snapshot is identical for ${provider}`,
        );
      }
    }
  }
});
