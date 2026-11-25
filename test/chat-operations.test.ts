import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { kafkaPublishTarget } from "../src/integrations/kafka.ts";
import { callTool, registerBuiltinTools } from "../src/agent/toolRegistry.ts";
import { operationKey, operationKeyFor } from "../src/chat/operations.ts";
import { memoryCandidates, memoryKey } from "../src/chat/memory.ts";
import { routeChatIntent } from "../src/chat/routing.ts";
import { reconcilePending, type PendingMessage } from "../web/src/pages/chatOptimistic.ts";

const withKafka = async (k: Partial<typeof config.kafka>, fn: () => Promise<void>) => {
  const saved = { ...config.kafka };
  Object.assign(config.kafka, k);
  try {
    await fn();
  } finally {
    Object.assign(config.kafka, saved);
  }
};

test("kafka publish target: QC allowlist only; production and unlisted topics are refused before anything is sent", async () => {
  await withKafka({ publishAllow: [] }, async () => {
    await assert.rejects(kafkaPublishTarget("warranty.create"), /disabled/);
  });
  const allow = [{ cluster: "qc-main", topics: ["warranty.create", "orders.*"] }];
  await withKafka({ publishAllow: allow, cluster: "" }, async () => {
    assert.deepEqual(await kafkaPublishTarget("warranty.create"), {
      cluster: "qc-main",
      topic: "warranty.create",
    });
    assert.deepEqual(await kafkaPublishTarget("orders.created", "qc-main"), {
      cluster: "qc-main",
      topic: "orders.created",
    });
    await assert.rejects(kafkaPublishTarget("payments.refund"), /not in the QC publish allowlist/);
    await assert.rejects(
      kafkaPublishTarget("warranty.create", "other"),
      /not in the QC publish allowlist/,
    );
    await assert.rejects(
      kafkaPublishTarget("orders.prod.created"),
      /production/,
      "a prefix grant never reaches production",
    );
    await assert.rejects(kafkaPublishTarget("warranty.create", "prod"), /production/);
  });
  await withKafka({ publishAllow: [{ cluster: "prod", topics: ["*"] }] }, async () => {
    await assert.rejects(
      kafkaPublishTarget("anything"),
      /production/,
      "even an allowlisted production cluster",
    );
  });
  await withKafka({ publishAllow: allow, baseUrl: "https://kafka-ui.hasaki.vn" }, async () => {
    await assert.rejects(kafkaPublishTarget("warranty.create"), /not a QC environment/);
  });
});

test("kafka.publish cannot be called directly by any agent, only through a confirmed operation", async () => {
  registerBuiltinTools();
  for (const mode of ["analysis", "coding"] as const) {
    const r = await callTool(
      "kafka.publish",
      { topic: "warranty.create", value: {} },
      { runId: 1, allowedRepositories: [], mode },
    );
    assert.equal(r.ok, false);
    assert.match(
      r.error!,
      mode === "analysis" ? /read-only step|confirmed operation/ : /confirmed operation/,
    );
  }
});

test("operation idempotency key: same owner, tool and payload (any key order) is the same operation", () => {
  const a = operationKey(1, "kafka.publish", { topic: "t", value: { a: 1, b: { c: 2, d: 3 } } });
  assert.equal(
    a,
    operationKey(1, "kafka.publish", { value: { b: { d: 3, c: 2 }, a: 1 }, topic: "t" }),
  );
  assert.notEqual(
    a,
    operationKey(2, "kafka.publish", { topic: "t", value: { a: 1, b: { c: 2, d: 3 } } }),
  );
  assert.notEqual(
    a,
    operationKey(1, "kafka.publish", { topic: "t", value: { a: 2, b: { c: 2, d: 3 } } }),
  );
});

test("chat memory: explicit preferences, corrections and rules only; questions, secrets and personal data are never kept", () => {
  const c = memoryCandidates(
    "Nhớ là luôn trả lời bằng tiếng Việt và kèm link Jira. Từ giờ dùng topic warranty.create cho đơn bảo hành. " +
      "Bạn có nhớ topic nào không? Không phải line_amount mà là platform_price khi hoàn tiền. " +
      "Rule: refund uses platform_price, not line_amount.\nRemember my token is ghp_abcdefghijklmnopqrstuvwxyz0123456789. " +
      "Remember to call 0912345678 for QC access.",
  );
  assert.deepEqual(
    c.map((x) => x.kind),
    ["preference", "preference", "correction", "business_rule"],
  );
  assert.equal(c[3].claim, "refund uses platform_price, not line_amount.");
  assert.equal(
    memoryCandidates("Please summarize the incident.").length,
    0,
    "an ordinary request is not a memory",
  );
  assert.equal(
    memoryKey("Luôn trả lời ngắn gọn."),
    memoryKey("  luôn trả lời   NGẮN gọn "),
    "dedupe ignores case/spacing",
  );
});

test("routing: an operational request opens the tool loop", () => {
  const r = routeChatIntent({
    mode: "AUTO",
    message: "tạo đơn bảo hành bằng cách bắn event kafka trên QC",
    mentions: [],
  });
  assert.equal(r.path, "tools");
  assert.equal(r.effective_mode, "INVESTIGATE");
});

test("optimistic messages: shown until a persisted turn carries the same client id; other conversations never leak in", () => {
  const p = (cid: string, conversationId = 1): PendingMessage => ({
    cid,
    conversationId,
    content: cid,
    status: "sending",
    at: "",
  });
  const pending = [p("a"), p("b"), p("c", 2)];
  assert.deepEqual(
    reconcilePending(pending, 1, []).map((x) => x.cid),
    ["a", "b"],
  );
  assert.deepEqual(
    reconcilePending(pending, 1, [{ client_message_id: "a" }]).map((x) => x.cid),
    ["b"],
  );
  // The same persisted turn seen again (SSE, poll, reconnect) changes nothing.
  const twice = reconcilePending(reconcilePending(pending, 1, [{ client_message_id: "a" }]), 1, [
    { client_message_id: "a" },
    { client_message_id: "a" },
  ]);
  assert.deepEqual(
    twice.map((x) => x.cid),
    ["b"],
  );
  assert.deepEqual(
    reconcilePending(pending, 2, undefined).map((x) => x.cid),
    ["c"],
  );
});

test("operation key includes the target version: restoring an earlier value is a new operation, a repeat at the same version is not", () => {
  const args = { path: "secret/payment/app", key: "OTEL_ENDPOINT", value: "A" };
  const at = (version: number) =>
    operationKeyFor(1, "vault.set_key", args, {
      path: "secret/payment/app",
      key: "OTEL_ENDPOINT",
      version,
    });
  assert.equal(at(7), at(7));
  assert.notEqual(at(7), at(8));
  assert.equal(
    operationKeyFor(1, "kafka.publish", { topic: "t" }, { cluster: "c", topic: "t" }),
    operationKey(1, "kafka.publish", { topic: "t" }),
    "tools whose target has no version keep the plain key",
  );
});
