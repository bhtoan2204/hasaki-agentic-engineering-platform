import { test } from "node:test";
import assert from "node:assert/strict";
import { continuesGoal, nextContinuation, type TurnFacts } from "../src/chat/continuation.ts";
import { routeChatIntent } from "../src/chat/routing.ts";
import { visibleAnswer } from "../src/chat/streaming.ts";
import type { Continuation } from "../src/chat/types.ts";

const open = (over: Partial<Continuation> = {}): Continuation => ({
  goal: "đọc message kafka topic warranty.create và tìm đơn bảo hành WR-1001",
  goal_turn_id: 10,
  route: "PLATFORM_QUERY",
  effective_mode: "INVESTIGATE",
  status: "blocked",
  completed: [],
  blockers: [
    { kind: "tool", tool: "kafka.read_messages", reason: "Kafka UI not connected", turn_id: 10 },
  ],
  operations: [],
  turns: [10],
  updated_at: new Date().toISOString(),
  ...over,
});
const decide = (message: string, cont: Continuation | null = open()) =>
  continuesGoal(message, cont, routeChatIntent({ mode: "AUTO", message, mentions: [] }));

test("follow-ups resume the unfinished request from context — short replies with no intent of their own, or the same subject", () => {
  for (const m of [
    "làm lại đi",
    "redo it",
    "connected now",
    "kết nối rồi đó",
    "tiếp tục",
    "try again please",
    "ok, thử lại xem",
  ])
    assert.equal(decide(m).continues, true, m);
  assert.equal(
    decide("còn topic warranty.create của đơn WR-1001 thì sao, đọc lại giúp").continues,
    true,
    "same subject",
  );
});

test("a new request with its own intent is a topic change; explicit mentions, stale state and no state never resume", () => {
  assert.equal(
    decide(
      "có bao nhiêu payment provider đang tích hợp trong repository oms-api và cổng thanh toán nào?",
    ).continues,
    false,
  );
  assert.equal(
    decide("show me the error rate of the checkout service in splunk for the last hour").continues,
    false,
  );
  assert.equal(decide("làm lại đi", null).continues, false);
  assert.equal(
    decide("làm lại đi", open({ updated_at: new Date(Date.now() - 2 * 86_400_000).toISOString() }))
      .continues,
    false,
  );
  assert.equal(
    continuesGoal("retry", open(), { route: "REPOSITORY_QUERY", source: "mention" }).continues,
    false,
    "a resolved @mention sets a new context",
  );
});

const facts = (over: Partial<TurnFacts> = {}): TurnFacts => ({
  turnId: 11,
  message: "đọc message kafka",
  route: "PLATFORM_QUERY",
  effectiveMode: "INVESTIGATE",
  path: "tools",
  status: "completed",
  failure: null,
  stopReason: null,
  toolCalls: [],
  operations: [],
  ...over,
});

test("state transitions come from platform facts: blockers and unfinished operations keep it open, a finished resume closes it", () => {
  const blocked = nextContinuation(
    null,
    facts({
      toolCalls: [
        {
          tool: "tools.call",
          arguments: { name: "kafka.read_messages" },
          status: "error",
          error: "Kafka UI not connected",
          evidence_ref: null,
        },
      ],
    }),
    false,
  )!;
  assert.deepEqual(
    [blocked.status, blocked.blockers[0].tool, blocked.goal_turn_id],
    ["blocked", "kafka.read_messages", 11],
  );

  const ok = {
    tool: "tools.call",
    arguments: { name: "kafka.read_messages" },
    status: "ok",
    label: "kafka",
    evidence_ref: "chat:1:tool:5",
  };
  assert.equal(
    nextContinuation(blocked, facts({ turnId: 12, toolCalls: [ok] }), true),
    null,
    "resumed and finished",
  );
  assert.equal(
    nextContinuation(blocked, facts({ turnId: 12, message: "other", toolCalls: [ok] }), false),
    blocked,
    "a clean new topic leaves the old request open",
  );
  assert.equal(
    nextContinuation(blocked, facts({ turnId: 12, path: "direct" }), false),
    blocked,
    "a direct answer changes nothing",
  );

  const pending = nextContinuation(
    null,
    facts({
      operations: [{ id: 7, tool: "kafka.publish", status: "pending", verification: null }],
    }),
    false,
  )!;
  assert.match(pending.blockers[0].reason, /operation #7 is pending/);
  const ran = nextContinuation(
    pending,
    facts({
      turnId: 12,
      operations: [{ id: 7, tool: "kafka.publish", status: "succeeded", verification: null }],
    }),
    true,
  )!;
  assert.match(
    ran.blockers[0].reason,
    /not verified/,
    "a success that was never verified is not finished",
  );
  assert.equal(
    nextContinuation(
      ran,
      facts({
        turnId: 13,
        operations: [
          { id: 7, tool: "kafka.publish", status: "succeeded", verification: { verified: true } },
        ],
      }),
      true,
    ),
    null,
  );
  const failedTurn = nextContinuation(
    null,
    facts({ status: "failed", failure: { code: "RATE_LIMITED", message: "429" } }),
    false,
  )!;
  assert.equal(failedTurn.blockers[0].kind, "turn");
});

test("the escalation marker never streams as answer text", () => {
  assert.equal(visibleAnswer("```chat-escalate```", false), "");
  assert.equal(visibleAnswer("Hi ```chat-esc", false), "Hi ");
  assert.equal(visibleAnswer("Plain answer", false), "Plain answer");
});
