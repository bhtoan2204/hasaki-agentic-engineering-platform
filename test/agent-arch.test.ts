import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { planKnowledge, planUpstream, scoreKnowledge, summarizeValue, estimateTokens, type KnowledgeLike } from "../src/context/plan.ts";
import { decide, toolsFor, type PolicyContext } from "../src/agent/toolPolicy.ts";
import { accumulateMetrics, newMetrics } from "../src/agent/claude.ts";
import { callTool, describeTool, listTools, registerBuiltinTools, registerIntegrationTool } from "../src/agent/toolRegistry.ts";
import { buildSystemAppend, buildUserPrompt } from "../src/agent/stepPrompt.ts";

before(async () => {
  await migrate();
  registerBuiltinTools();
});
after(() => pool.end());

const k = (key: string, over: Partial<KnowledgeLike> = {}): KnowledgeLike => ({ key, title: key, category: "agent_skill", content: "x".repeat(400), reason: "skill for repos oms-api", metadata: { load: "on_demand", description: "" }, ...over });

// ---------------------------------------------------------------- skill discovery & progressive disclosure
test("relevance: skills matching the request rank above unrelated ones, with an explanation", () => {
  const req = "Fix refund amount for shipment cancel; COD money mismatch";
  const money = scoreKnowledge(k("skill.oms-money-model", { title: "Skill: oms-money-model", metadata: { description: "Money semantics: refund, COD, shipping fee" } }), req, "agent");
  const kafka = scoreKnowledge(k("skill.oms-kafka-consumer", { title: "Skill: oms-kafka-consumer", metadata: { description: "add kafka consumers, topics, DLQ" } }), req, "agent");
  assert.ok(money.score > kafka.score);
  assert.match(money.why, /refund|cod/);
});

test("disclosure: mandatory items always inline, budgeted inline, top-N index, rest search-only", () => {
  const items = [
    k("assigned", { reason: "assigned to step", content: "a".repeat(40_000) }), // over budget but mandatory
    k("policy", { category: "security_policy", enforced: true, reason: "GLOBAL scope", metadata: {} }),
    k("conv.big", { category: "repository_convention", reason: "REPOSITORY:oms-api scope", metadata: { load: "inline", description: "refund rules" }, content: "c".repeat(20_000) }),
    ...Array.from({ length: 15 }, (_, i) => k(`skill.s${i}`, { metadata: { load: "on_demand", description: i < 3 ? "refund shipment" : "unrelated topic" } })),
  ];
  const plan = planKnowledge(items, { requestText: "refund shipment", stepType: "agent", inlineTokens: 1000, indexSize: 5 });
  const by = Object.fromEntries(plan.map((d) => [d.key, d]));
  assert.equal(by.assigned.disclosure, "inline");
  assert.equal(by.policy.disclosure, "inline");
  assert.equal(by["conv.big"].disclosure, "index", "over the inline budget → demoted to index, not dropped");
  assert.match(by["conv.big"].why, /over inline budget/);
  assert.equal(plan.filter((d) => d.disclosure === "index").length, 5);
  for (const i of [0, 1, 2]) assert.equal(by[`skill.s${i}`].disclosure, "index", "relevant skills make the index");
  assert.equal(plan.filter((d) => d.disclosure === "search").length, items.length - 2 - 5);
});

test("system prompt shows inline bodies, index lines, a search hint, tool discovery, and delegation only when enabled", () => {
  const run: any = { id: 1, definition_key: "wf", branch: "T-1", allowed_repositories: ["oms-api"] };
  const knowledge: any[] = [
    { key: "rule", version: 1, category: "business_rule", title: "Refund once", reason: "GLOBAL scope", content: "RULE BODY", metadata: {} },
    { key: "skill.a", version: 2, category: "agent_skill", title: "Skill A", reason: "skill", content: "SKILL A BODY", metadata: { description: "does A" } },
    { key: "skill.b", version: 1, category: "agent_skill", title: "Skill B", reason: "skill", content: "SKILL B BODY", metadata: { description: "does B" } },
  ];
  const ctx: any = { repositories: ["oms-api"], knowledge, overridden: [], disclosure: [{ key: "rule", disclosure: "inline" }, { key: "skill.a", disclosure: "index" }, { key: "skill.b", disclosure: "search" }] };
  const sys = buildSystemAppend(run, { key: "s", name: "S", type: "agent", config: {} } as any, ctx, "analysis");
  assert.ok(sys.includes("RULE BODY"));
  assert.ok(sys.includes("`skill.a`") && !sys.includes("SKILL A BODY"), "index lists, does not inline");
  assert.ok(!sys.includes("skill.b") && sys.includes("1 more applicable"), "search tier hidden but announced");
  assert.ok(sys.includes("mcp__platform__list_tools"));
  assert.ok(!sys.includes("Delegation"));
  assert.ok(buildSystemAppend(run, { key: "s", name: "S", type: "agent", config: { delegation: { enabled: true } } } as any, ctx, "analysis").includes("explorer"));
});

// ---------------------------------------------------------------- context budgeting
test("upstream budget: small outputs stay full, large ones are summarized; direct deps get a bigger share", () => {
  const big = { summary: "root cause found", evidence: Array.from({ length: 300 }, (_, i) => `file_${i}.go:${i}: ${"detail ".repeat(20)}`) };
  const { plan, text } = planUpstream(
    { small: { output: { ok: true }, attempt_id: 1 }, direct: { output: big, attempt_id: 2 }, old: { output: big, attempt_id: 3 } },
    ["direct"],
    3000,
  );
  assert.equal(plan.small.mode, "full");
  assert.equal(plan.direct.mode, "summary");
  assert.ok(plan.direct.tokens > plan.old.tokens, "direct dependency gets more of the budget");
  assert.ok(Object.values(plan).reduce((a, p) => a + p.tokens, 0) <= 3000 + 64);
  assert.ok(text.direct.includes("root cause found"), "summary keeps the shape and leading content");
  assert.equal(summarizeValue(big, 500), summarizeValue(big, 500), "deterministic");
  assert.ok(summarizeValue(big, 500).length <= 500);
  const prompt = buildUserPrompt({ run: { inputs: {}, selected_repositories: [] }, work_item: null, upstream: { direct: { status: "COMPLETED", attempt_id: 2, output: big } }, answers: [], pending: null } as any, [], [], { plan, text });
  assert.ok(prompt.includes('read_step_output("direct")'));
  assert.ok(estimateTokens(prompt) < estimateTokens(JSON.stringify(big)));
});

// ---------------------------------------------------------------- tools & permissions
test("native tools: Task/Agent only with delegation, Skill only when Claude Code settings are loaded", () => {
  assert.ok(!toolsFor("analysis").includes("Task"));
  assert.ok(!toolsFor("coding").includes("Skill"));
  assert.ok(toolsFor("analysis", { delegation: true }).includes("Task"));
  assert.ok(toolsFor("analysis", { claudeSkills: true }).includes("Skill"));
  assert.ok(toolsFor("coding").includes("Edit") && !toolsFor("analysis").includes("Edit"));
});

test("subagents inherit restrictions and are read-only; delegation must be enabled", () => {
  const ctx: PolicyContext = { mode: "coding", workspaces: ["/w/T1/oms-api"], baseBranch: "release/prod", protectedRoots: ["/src"], delegation: true, isReadOnlyIntegration: (n) => n === "repositories.search" };
  assert.ok(decide("Edit", { file_path: "/w/T1/oms-api/a.go" }, ctx).allow, "main coding agent may edit its worktree");
  assert.ok(!decide("Edit", { file_path: "/w/T1/oms-api/a.go" }, ctx, undefined, "sub-1").allow, "subagent may not edit even in a coding step");
  assert.ok(!decide("Bash", { command: "go mod tidy" }, ctx, "/w/T1/oms-api", "sub-1").allow, "subagent shell is read-only");
  assert.ok(decide("Bash", { command: "git log --oneline -3" }, ctx, "/w/T1/oms-api", "sub-1").allow);
  assert.ok(!decide("mcp__platform__prepare_branch", { repo: "oms-api" }, ctx, undefined, "sub-1").allow);
  assert.ok(!decide("mcp__platform__submit_result", {}, ctx, undefined, "sub-1").allow);
  assert.ok(decide("mcp__platform__read_knowledge", { key: "x" }, ctx, undefined, "sub-1").allow);
  assert.ok(decide("mcp__platform__call_tool", { name: "repositories.search" }, ctx, undefined, "sub-1").allow);
  assert.ok(!decide("mcp__platform__call_tool", { name: "something.write" }, ctx, undefined, "sub-1").allow);
  assert.ok(!decide("Task", {}, ctx, undefined, "sub-1").allow, "no nested delegation");
  assert.ok(decide("Task", {}, ctx).allow);
  assert.ok(!decide("Task", {}, { ...ctx, delegation: false }).allow, "delegation off by default");
});

test("tool registry: ranked discovery, on-demand schema, validated + permission-checked calls", async () => {
  let written = 0;
  registerIntegrationTool({
    name: "test.write_note",
    summary: "Write a note somewhere (changes state).",
    description: "test tool",
    input: z.object({ text: z.string() }),
    readOnly: false,
    available: () => true,
    handler: async () => (++written, { ok: true }),
  });
  const found = listTools("pull requests bitbucket", { mode: "analysis" });
  assert.equal(found[0].name, "bitbucket.list_pull_requests");
  assert.ok(listTools(undefined, { mode: "analysis" }).length >= 7);
  const d = describeTool("repositories.search");
  assert.equal((d.input_schema as any).type, "object");
  assert.ok((d.input_schema as any).properties.query);
  const ctx = { runId: 0, allowedRepositories: ["oms-api"], mode: "analysis" as const };
  assert.match((await callTool("nope", {}, ctx)).error!, /unknown tool/);
  assert.match((await callTool("repositories.search", { query: 1 }, ctx)).error!, /invalid arguments/);
  assert.match((await callTool("test.write_note", { text: "x" }, ctx)).error!, /read-only step/);
  assert.equal(written, 0);
  assert.equal((await callTool("test.write_note", { text: "x" }, { ...ctx, mode: "coding" })).ok, true);
  assert.equal(written, 1);
  assert.match((await callTool("bitbucket.list_pull_requests", { repo: "payment-src" }, ctx)).error!, /unavailable|outside/);
});

// ---------------------------------------------------------------- observability
test("metrics accumulate tokens, cost, tool usage and errors across sessions", () => {
  const m = newMetrics("opus");
  accumulateMetrics(m, { type: "system", subtype: "init" });
  accumulateMetrics(m, { type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }, { type: "tool_use", name: "Read" }, { type: "tool_use", name: "mcp__platform__read_knowledge" }] } });
  accumulateMetrics(m, { type: "user", message: { content: [{ type: "tool_result", is_error: true }] } });
  accumulateMetrics(m, { type: "result", num_turns: 3, duration_ms: 1200, total_cost_usd: 0.1, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 } });
  accumulateMetrics(m, { type: "system", subtype: "init" });
  accumulateMetrics(m, { type: "result", num_turns: 2, duration_ms: 800, total_cost_usd: 0.05, usage: { input_tokens: 1, output_tokens: 2 } });
  assert.equal(m.sessions, 2);
  assert.equal(m.turns, 5);
  assert.equal(m.cost_usd, 0.15);
  assert.deepEqual(m.tokens, { input: 11, output: 22, cache_read: 5, cache_creation: null });
  assert.deepEqual(m.tool_calls, { Read: 2, mcp__platform__read_knowledge: 1 });
  assert.equal(m.tool_errors, 1);
});
