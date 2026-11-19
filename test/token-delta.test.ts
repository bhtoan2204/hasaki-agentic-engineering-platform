import { test } from "node:test";
import assert from "node:assert/strict";
import { entryHashes, planContextDelivery } from "../src/context/delivery.ts";
import { compactToolResults, deltaPrompt } from "../src/chat/context.ts";
import { compressToolOutput } from "../src/agent/toolRegistry.ts";
import { addUsage } from "../src/chat/runtime.ts";
import type { ContextPack, ContextEntry } from "../src/context/pack.ts";

const entry = (
  id: string,
  body: string,
  section: ContextEntry["section"] = "requirements",
): ContextEntry => ({
  id,
  section,
  trust: "untrusted_evidence",
  required: true,
  priority: 1,
  body,
  provenance: {} as ContextEntry["provenance"],
});
const pack = (...entries: ContextEntry[]) => ({ entries }) as unknown as ContextPack;
const current = (p: ContextPack, systemHash = "sys", decisionsHash = "dec") => ({
  pack: p,
  systemHash,
  decisionsHash,
});
const manifest = (p: ContextPack, system_hash = "sys", decisions_hash = "dec") => ({
  system_hash,
  decisions_hash,
  entries: entryHashes(p),
});

test("delivery plan: unknown session or a changed system prompt resends everything; otherwise only what changed", () => {
  const p1 = pack(
    entry("request", "fix the refund"),
    entry("search_code", "code v1", "code"),
    entry("knowledge:7:v1", "rule", "knowledge"),
  );
  assert.equal(planContextDelivery(null, current(p1)).mode, "full");
  assert.equal(planContextDelivery(manifest(p1, "old-sys"), current(p1)).mode, "full");

  const same = planContextDelivery(manifest(p1), current(p1));
  assert.deepEqual(same, {
    mode: "delta",
    send: [],
    unchanged: ["request", "search_code", "knowledge:7:v1"],
    decisionsChanged: false,
  });

  const p2 = pack(
    entry("request", "fix the refund"),
    entry("search_code", "code v2 after a commit", "code"),
    entry("knowledge:7:v2", "rule, revised", "knowledge"),
  );
  const changed = planContextDelivery(manifest(p1), current(p2, "sys", "dec2"));
  assert.equal(changed.mode, "delta");
  assert.deepEqual(
    changed.mode === "delta" && changed.send,
    ["search_code", "knowledge:7:v2"],
    "a code change and a new knowledge version are resent",
  );
  assert.equal(changed.mode === "delta" && changed.decisionsChanged, true);
});

test("delivery plan: context the session saw but may no longer see forces a fresh session", () => {
  const before = pack(
    entry("request", "r"),
    entry("knowledge:9:v1", "private repo rule", "knowledge"),
    entry("search_code", "c", "code"),
  );
  const revoked = pack(entry("request", "r"), entry("search_code", "c", "code"));
  const plan = planContextDelivery(manifest(before), current(revoked));
  assert.deepEqual(plan, {
    mode: "fresh_session",
    reason: "delivered context is no longer authorized or in scope",
    removed: ["knowledge:9:v1"],
  });
  const narrowed = pack(
    entry("request", "r"),
    entry("knowledge:9:v1", "private repo rule", "knowledge"),
  );
  assert.equal(
    planContextDelivery(manifest(before), current(narrowed)).mode,
    "fresh_session",
    "removed code evidence too",
  );
});

test("stateless chat steps: earlier successful results are compacted (errors kept), the latest batch stays complete", () => {
  const long = "x".repeat(3000);
  const out = compactToolResults(
    [
      { seq: 1, tool: "code.search", status: "ok", body: long },
      { seq: 2, tool: "code.read_file", status: "error", body: `boom ${long}` },
      { seq: 3, tool: "code.read_file", status: "ok", body: long },
    ],
    3,
  );
  assert.match(out[0].body, /compacted: 3000 chars; full result via evidence.get \{"seq": 1\}/);
  assert.equal(out[1].body.length, long.length + 5, "errors are never compacted");
  assert.equal(out[2].body, long, "latest batch intact");
});

test("a kept session receives only the delta: new results, a newly opened catalog, or a withdrawal notice", () => {
  const d = deltaPrompt({
    results: [{ seq: 4, tool: "repo.list", status: "ok", body: "[]" }],
    catalog: "- repo.list",
    catalogNewlyOpened: true,
    toolsWithdrawn: false,
  });
  assert.match(d, /tool #4 repo\.list/);
  assert.match(d, /Tools are now available[\s\S]*- repo\.list/);
  assert.doesNotMatch(d, /Platform policy|Current user message/);
  assert.match(
    deltaPrompt({ results: [], catalog: null, catalogNewlyOpened: false, toolsWithdrawn: true }),
    /No more tool calls/,
  );
});

test("tool output compression keeps errors and source locations and points to the raw output", () => {
  const lines = Array.from({ length: 4000 }, (_, i) =>
    i === 2500 ? "panic: nil map at app/shipping/spx.go:142" : `ok line ${i} ${"y".repeat(20)}`,
  );
  const out = compressToolOutput({ log: lines }, 20_000, 'read_artifact {"artifact_id": 9}');
  assert.ok(out.length <= 21_000);
  assert.match(out, /panic: nil map at app\/shipping\/spx\.go:142/);
  assert.match(out, /full output: read_artifact \{"artifact_id": 9\}/);
  assert.equal(
    compressToolOutput({ a: 1 }, 100),
    JSON.stringify({ a: 1 }, null, 2),
    "small results are untouched",
  );
});

test("chat usage keeps provider-reported cache tokens apart; unknown stays unknown", () => {
  const u = {
    completions: 0,
    tool_calls: 0,
    provider_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: 0,
  };
  addUsage(u, {
    provider_execution_ms: 1,
    cost_usd: 0.01,
    tokens: { input: 100, output: 10, cache_read: 900, cache_creation: 50 },
  });
  assert.deepEqual([u.input_tokens, u.cache_read_tokens, u.cache_creation_tokens], [100, 900, 50]);
  addUsage(u, { provider_execution_ms: 1, cost_usd: null, tokens: { input: 5, output: 1 } });
  assert.deepEqual([u.input_tokens, u.cache_read_tokens, u.cost_usd], [105, null, null]);
});

test("a delta resume message carries only new or changed context and repeats decisions only when they changed", async () => {
  const { buildResumeMessage } = await import("../src/agent/stepPrompt.ts");
  const input = {
    answers: [{ attempt_id: 5, question: "Which topic?", answer: "warranty.create" }],
    run: { output_locale: "en", inputs: { developer_decisions: [{ text: "Never retry 4xx" }] } },
    pending: {},
  } as never;
  const p = {
    id: 1,
    snapshot_id: 1,
    token_measurement: "character_estimate_not_provider_usage",
    estimated_tokens: 1,
    omitted: [],
    entries: [
      entry("request", "UNCHANGED REQUEST BODY"),
      entry("evidence_summary", "NEW EVIDENCE BODY", "decisions"),
    ],
  } as unknown as ContextPack;
  const full = buildResumeMessage(input, 5, [], "en", p);
  const delta = buildResumeMessage(input, 5, [], "en", p, {
    send: ["evidence_summary"],
    unchanged: ["request"],
    decisionsChanged: false,
  });
  assert.match(full, /UNCHANGED REQUEST BODY/);
  assert.doesNotMatch(delta, /UNCHANGED REQUEST BODY/);
  assert.match(delta, /NEW EVIDENCE BODY/);
  assert.match(delta, /Unchanged and already in this conversation \(not repeated\): request/);
  assert.doesNotMatch(delta, /Never retry 4xx/, "unchanged decisions are already in the session");
  assert.match(delta, /warranty\.create/, "new answers are always sent");
  assert.ok(delta.length < full.length);
  assert.match(
    buildResumeMessage(input, 5, [], "en", p, {
      send: [],
      unchanged: ["request", "evidence_summary"],
      decisionsChanged: true,
    }),
    /Never retry 4xx/,
  );
});
