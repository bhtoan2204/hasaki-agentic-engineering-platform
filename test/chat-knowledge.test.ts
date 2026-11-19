import { test } from "node:test";
import assert from "node:assert/strict";
import { planKnowledge, requestTerms, scoreKnowledge } from "../src/context/plan.ts";

// The shape knowledge.list() returns: a registry row with its version, never a resolution `reason`.
const row = {
  key: "rules.refund",
  title: "Refund amount",
  category: "business_rule",
  scope_type: "GLOBAL",
  content: "Refund uses platform_price, not line_amount.",
  metadata: {},
};

test("regression: scoring a registry row without resolution output does not throw (Cannot read properties of undefined (reading 'startsWith'))", () => {
  assert.doesNotThrow(() => scoreKnowledge(row, "refund amount", "agent"));
  assert.ok(scoreKnowledge(row, "refund amount", "agent").score > 0);
  assert.equal(
    scoreKnowledge({ ...row, scope_type: "REPOSITORY" }, "refund", "agent").score -
      scoreKnowledge(row, "refund", "agent").score,
    2,
    "repository scope still ranks higher (from scope_type, not from parsing a reason string)",
  );
  // Resolved items keep working in the disclosure planner.
  const plan = planKnowledge([{ ...row, reason: "GLOBAL scope" }], {
    requestText: "refund",
    stepType: "agent",
    inlineTokens: 100,
    indexSize: 3,
  });
  assert.equal(plan[0].disclosure, "inline", "a relevant business rule is mandatory inline");
});

test("bilingual business terms: Vietnamese and English requests find knowledge written in the other language", () => {
  const vi = {
    ...row,
    key: "rules.hoan-tien",
    title: "Quy tắc hoàn tiền",
    content: "Hoàn tiền dùng platform_price cho đơn hàng.",
  };
  assert.ok(scoreKnowledge(vi, "How is the refund amount computed?", "agent").score > 0);
  assert.ok(scoreKnowledge(row, "tính tiền hoàn tiền thế nào", "agent").score > 0);
  assert.ok(
    scoreKnowledge({ ...row, title: "Warranty orders", content: "" }, "tạo đơn bảo hành", "agent")
      .score > 0,
  );
  assert.ok(requestTerms("refunds").has("refund"), "synonyms of a concept");
  assert.equal(
    scoreKnowledge({ ...row, title: "Payment gateway", content: "" }, "khách hàng Huy hỏi", "agent")
      .score,
    0,
    "no spurious concept from names",
  );
});
