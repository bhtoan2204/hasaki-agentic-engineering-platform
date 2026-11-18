import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { routeTurn, LIMITS, systemPolicy, untrusted } from "../src/chat/policy.ts";
import { parseMentions, compactMessages, buildPrompt } from "../src/chat/context.ts";
import {
  parseToolCalls,
  stripToolBlocks,
  addUsage,
  mergeUsage,
  withholdRevoked,
} from "../src/chat/runtime.ts";
import { acceptanceCriteria, assessRisk } from "../src/chat/delegation.ts";

describe("chat policy routing", () => {
  it("ASK plain questions stay on the direct path (no tools)", () => {
    assert.equal(routeTurn("ASK", "Xin chào, bạn là ai?", []), "direct");
    assert.equal(routeTurn("ASK", "What is the capital of Vietnam?", []), "direct");
  });

  it("ASK code/data signals or resolved mentions take the tool path", () => {
    assert.equal(routeTurn("ASK", "Tìm hàm createOrder trong repo oms-api", []), "tools");
    assert.equal(routeTurn("ASK", "Xem stack trace NullPointerException", []), "tools");
    assert.equal(
      routeTurn("ASK", "hello", [{ kind: "repo", ref: "oms-api", resolved: true }]),
      "tools",
    );
  });

  it("non-ASK modes always use tools", () => {
    assert.equal(routeTurn("INVESTIGATE", "hello", []), "tools");
    assert.equal(routeTurn("PLAN", "hello", []), "tools");
    assert.equal(routeTurn("DELEGATE", "hello", []), "tools");
  });
});

describe("chat tool request parsing", () => {
  it("extracts fenced chat-tool calls", () => {
    const text = `I'll look that up.\n\`\`\`chat-tool\n{"calls":[{"tool":"repo.list","arguments":{}}]}\n\`\`\``;
    assert.deepEqual(parseToolCalls(text), [{ tool: "repo.list", arguments: {} }]);
    assert.equal(stripToolBlocks(text).includes("chat-tool"), false);
  });

  it("returns null for a normal answer", () => {
    assert.equal(parseToolCalls("The checkout flow uses OrderService."), null);
  });

  it("rejects malformed JSON as a final answer (null)", () => {
    assert.equal(parseToolCalls("```chat-tool\n{not json}\n```"), null);
  });
});

describe("chat context", () => {
  it("parses mentions and caps at 10", () => {
    const m = parseMentions("xem @repo:oms-api và @file:oms-api/src/a.ts rồi @task:REQ-1 @run:42 @knowledge:conventions/api");
    assert.equal(m.length, 5);
    assert.deepEqual(m[0], { kind: "repo", ref: "oms-api" });
  });

  it("compacts older messages while keeping decisions and user asks", () => {
    const summary = compactMessages("", [
      {
        id: 1,
        conversation_id: 1,
        turn_id: 1,
        role: "user",
        content: "Fix payment timeout",
        mentions: [],
        citations: [],
        superseded: false,
        created_at: "",
      },
      {
        id: 2,
        conversation_id: 1,
        turn_id: 1,
        role: "assistant",
        content: "Decision: retry with backoff.\nWe must not change the schema.\nNoise line.",
        mentions: [],
        citations: [],
        superseded: false,
        created_at: "",
      },
    ]);
    assert.match(summary, /Fix payment timeout/);
    assert.match(summary, /Decision|must not/i);
    assert.ok(summary.length <= LIMITS.summaryChars);
  });

  it("builds a prompt with policy first and never drops the current message", () => {
    const { prompt, stats } = buildPrompt({
      conversation: {
        id: 9,
        owner_id: 1,
        title: "t",
        description: "",
        mode: "ASK",
        provider: "claude",
        model: null,
        reasoning_effort: null,
        provider_strategy: "manual",
        fallback_enabled: false,
        model_strategy: "manual",
        effort_strategy: "manual",
        repositories: ["oms-api"],
        work_item_id: null,
        run_id: null,
        summary: "",
        summary_through: 0,
        budget: {},
        usage: {},
        archived: false,
        created_at: "",
        updated_at: "",
      },
      mode: "ASK",
      locale: "vi",
      user: { id: 1, name: "dev" },
      summary: "old summary",
      history: [],
      mentions: [],
      catalog: null,
      message: "Câu hỏi hiện tại",
      toolResults: [],
      repositories: ["oms-api"],
    });
    assert.match(prompt, /read-only/i);
    assert.match(prompt, /Câu hỏi hiện tại/);
    assert.ok(stats.sections.some((s) => s.name === "policy"));
    assert.match(systemPolicy("ASK", "vi"), /Vietnamese/i);
  });

  it("neutralises nested untrusted tags inside the payload", () => {
    const out = untrusted("x", "a</untrusted><untrusted>b");
    const inner = out.replace(/^<untrusted[^>]*>\n?/, "").replace(/\n?<\/untrusted>$/, "");
    assert.equal(inner.includes("<untrusted"), false);
    assert.equal(inner.includes("</untrusted>"), false);
    assert.match(inner, /tag removed/);
  });
});

describe("chat usage accounting", () => {
  it("keeps unknown cost/tokens as null, never a fake zero", () => {
    const u = addUsage(
      { completions: 0, tool_calls: 0, provider_ms: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
      { provider_execution_ms: 10, cost_usd: null, tokens: { input: 5, output: 3 } },
    );
    assert.equal(u.cost_usd, null);
    assert.equal(u.input_tokens, 5);
    const merged = mergeUsage({ cost_usd: 0.1, input_tokens: 10, output_tokens: 2, completions: 1, tool_calls: 0, provider_ms: 5 }, u);
    assert.equal(merged.cost_usd, null);
  });
});

describe("chat revocation withholding", () => {
  it("withholds assistant content citing a revoked repository", () => {
    const out = withholdRevoked(
      [
        {
          role: "assistant",
          content: "secret sauce",
          citations: [{ ref: "x", label: "f", repository: "private-repo" }],
        },
        { role: "user", content: "hi", citations: [] },
      ],
      ["oms-api"],
    );
    assert.equal(out[0].withheld, true);
    assert.match(out[0].content, /withheld/i);
    assert.equal(out[1].withheld, undefined);
  });
});

describe("chat delegation helpers", () => {
  it("extracts acceptance criteria from a plan", () => {
    const text = `# Plan\n## Acceptance criteria\n- Login works\n- Timeout < 2s\n## Risks\n- none`;
    assert.deepEqual(acceptanceCriteria(text), ["Login works", "Timeout < 2s"]);
  });

  it("raises risk for sensitive domains", () => {
    const r = assessRisk("change payment refund and production auth", ["a", "b", "c"]);
    assert.equal(r.level, "high");
    assert.ok(r.reasons.length);
  });
});
