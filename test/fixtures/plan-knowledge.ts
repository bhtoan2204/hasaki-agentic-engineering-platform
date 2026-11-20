import type { KnowledgeLike } from "../../src/context/plan.ts";

const item = (
  key: string,
  category: string,
  content: string,
  extra: Partial<KnowledgeLike> = {},
): KnowledgeLike => ({
  key,
  title: key.replace(/[._]/g, " "),
  category,
  content,
  reason: "applies",
  ...extra,
});

/** A step's resolved knowledge covering every planKnowledge branch (mandatory kinds, budget overflow, pins, companions). */
export const planItems: KnowledgeLike[] = [
  item("policy.security", "security_policy", "Never log secrets.", { enforced: true }),
  item("rule.refund.window", "business_rule", "Refunds are allowed within 30 days of delivery."),
  item("skill.assigned", "agent_skill", "Assigned skill body ".repeat(40), {
    reason: "assigned to step",
  }),
  item("skill.reexec", "agent_skill", "Pinned body", {
    reason: "selected for this re-execution (v2)",
  }),
  item("convention.order.api", "repository_convention", "Order API uses snake_case. ".repeat(30), {
    scope_type: "REPOSITORY",
  }),
  item("convention.logging", "coding_standard", "Use structured logging for order events."),
  item("doc.refund.flow", "reference_doc", "Refund flow: order, payment, ledger. ".repeat(200)),
  item("doc.shipping", "reference_doc", "Shipping carriers and delivery SLAs.", {
    metadata: { load: "on_demand", description: "delivery carriers" },
  }),
  item("doc.invoice", "reference_doc", "Invoice numbering.", {
    metadata: { load: "on_demand", description: "invoice series for orders" },
  }),
  item("doc.unrelated", "reference_doc", "Holiday calendar.", { metadata: { load: "on_demand" } }),
  item("skill.refund", "agent_skill", "How to handle a refund request.", {
    metadata: { load: "on_demand", description: "refund handling", applicable_steps: ["agent"] },
  }),
  item("skill.refund.reference", "reference_doc", "Refund reference tables.", {
    metadata: { load: "on_demand", parent_skill: "skill.refund" },
  }),
  item("memory.task.unverified", "task_memory", "Refund job was flaky once.", {
    metadata: { memory: { trust: "unverified" }, load: "inline" },
  }),
  item("memory.task.verified", "task_memory", "Order refund endpoint is idempotent.", {
    metadata: { memory: { trust: "verified" } },
  }),
];

export const planOptions = [
  {
    requestText: "hoàn tiền đơn hàng refund order",
    stepType: "agent",
    inlineTokens: 400,
    indexSize: 2,
  },
  {
    requestText: "shipping delivery invoice",
    stepType: "coding_agent",
    inlineTokens: 100000,
    indexSize: 12,
  },
  { requestText: "", stepType: "agent", inlineTokens: 0, indexSize: 0 },
];
