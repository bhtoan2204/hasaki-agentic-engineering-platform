import { z } from "zod";
import { createHash } from "node:crypto";

export const sha256 = (v: string) =>
  createHash("sha256").update(v).digest("hex");
const relativePath = z
  .string()
  .min(1)
  .max(120)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.split("/").some((x) => ["..", ".git", ""].includes(x)),
    "Unsafe fixture path",
  );
export const CaseSchema = z.object({
  task_id: z.string().regex(/^BENCH-\d{3}$/),
  category: z.string().min(1),
  difficulty: z.enum(["easy", "medium", "hard"]),
  origin: z.enum(["synthetic", "real_derived"]),
  provenance: z.string().min(10),
  description: z.string().min(10),
  repository: z.string().regex(/^fixture-[a-z-]+$/),
  repositories: z
    .array(z.string().regex(/^fixture-[a-z-]+$/))
    .min(1)
    .max(4),
  base_commit: z.string().regex(/^[a-f0-9]{40}$/),
  expected_behavior: z.array(z.string().min(3)).min(1),
  validation: z.object({
    type: z.enum(["behavior", "proto", "sql", "navigation", "freshness"]),
    path: relativePath,
    export_name: z.string().optional(),
    public_checks: z.array(
      z.object({ args: z.array(z.unknown()), expected: z.unknown() }),
    ),
    hidden_checks: z.array(
      z.object({ args: z.array(z.unknown()), expected: z.unknown() }),
    ),
    timeout_seconds: z.number().int().min(1).max(30),
  }),
  allowed_changes: z
    .array(z.object({ repository: z.string(), path: relativePath }))
    .max(4),
  tags: z.array(z.string()),
  critical: z.boolean(),
  clarification: z
    .object({ question: z.string(), answer: z.string() })
    .optional(),
  transient_once: z.boolean().optional(),
});
export type BenchmarkCase = z.infer<typeof CaseSchema>;
export const SuiteSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9-]+$/),
    version: z.number().int().positive(),
    title: z.string(),
    fixture_version: z.string(),
    harness_hash: z.string(),
    repositories: z.record(
      z.string(),
      z.object({
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        tree_hash: z.string(),
      }),
    ),
    cases: z.array(CaseSchema).min(10).max(20),
  })
  .superRefine((s, ctx) => {
    const ids = new Set<string>();
    for (const c of s.cases) {
      if (ids.has(c.task_id))
        ctx.addIssue({
          code: "custom",
          message: "Duplicate benchmark task id",
        });
      ids.add(c.task_id);
      if (
        !s.repositories[c.repository] ||
        s.repositories[c.repository].commit !== c.base_commit
      )
        ctx.addIssue({
          code: "custom",
          message: "Case commit is not pinned to its fixture repository",
        });
      if (
        c.repositories.some((r) => !s.repositories[r]) ||
        !c.repositories.includes(c.repository)
      )
        ctx.addIssue({ code: "custom", message: "Unknown fixture repository" });
      if (c.origin === "real_derived" && !c.provenance.startsWith("verified:"))
        ctx.addIssue({
          code: "custom",
          message: "real_derived requires verified provenance",
        });
    }
  });
export type BenchmarkSuite = z.infer<typeof SuiteSchema>;
export const FIXTURE_VERSION = "synthetic-backend-1";
export const repositoryNames = [
  "fixture-alpha-service",
  "fixture-payment-service",
  "fixture-shared-proto",
];
const baseline: Record<string, Record<string, string>> = {
  "fixture-alpha-service": {
    "state.ts": "export function transition(state, event) { return event; }\n",
    "events.ts": "export function applyEvent(state, event) { return event; }\n",
    "hydration.ts":
      "export function hydrateOrders(orders, fetchBatch) { return orders.map(o => ({...o, customer: fetchBatch([o.customerId])[0]})); }\n",
  },
  "fixture-payment-service": {
    "refund.ts":
      'export function CalculateRefund(price, quantity, refunded) { return price * quantity; }\nexport function FindRefundHandler() { return "refund"; }\n',
    "api.ts": "export function serializePayment(p) { return {id:p.id}; }\n",
    "client.ts":
      "export function requestPayment(id, currency) { return {id}; }\n",
    "idempotency.ts":
      "export function chargeEvents(events) { return events.reduce((sum,e) => sum + e.amount,0); }\n",
    "money.ts":
      "export function money(amount) { return Math.floor(amount * 100) / 100; }\n",
    "policy.ts": 'export function refundPolicy() { return "unspecified"; }\n',
    "transaction.ts":
      "export function transfer(a,b,amount) { a.balance -= amount; if (b.closed) return false; b.balance += amount; return true; }\n",
    "retry.ts": "export function retryValue() { return false; }\n",
    "freshness.ts": 'export function SnapshotMarker() { return "old"; }\n',
    "pagination.sql":
      "SELECT id FROM payments ORDER BY id LIMIT $2 OFFSET $1;\n",
  },
  "fixture-shared-proto": {
    "payment.proto":
      'syntax = "proto3"; package fixture.payment; message Request { string id = 1; } message Reply { bool ok = 1; } service Payment { rpc Charge(Request) returns(Reply); }\n',
  },
};
export const fixtureTrees = Object.fromEntries(
  repositoryNames.map((name) => [
    name,
    { "package.json": '{"type":"module","private":true}\n', ...baseline[name] },
  ]),
);
/** Reference patches are trusted harness controls, never generated by or shown as agent solutions. */
export const referencePatches: Record<
  string,
  Array<{ repository: string; path: string; content: string }>
> = {};
const cases: Omit<BenchmarkCase, "base_commit">[] = [];
function add(
  n: number,
  category: string,
  difficulty: BenchmarkCase["difficulty"],
  repository: string,
  path: string,
  fn: string,
  description: string,
  expected: string[],
  checks: Array<[unknown[], unknown]>,
  fixed: string,
  options: Partial<Omit<BenchmarkCase, "base_commit">> = {},
) {
  const id = `BENCH-${String(n).padStart(3, "0")}`;
  const allowed = path ? [{ repository, path }] : [];
  cases.push({
    task_id: id,
    category,
    difficulty,
    origin: "synthetic",
    provenance:
      "Synthetic fixture; coverage inspired by src/cli/bench.ts, platform verification tests and P1 validation; not a verified historical ticket.",
    description,
    repository,
    repositories: [repository],
    expected_behavior: expected,
    validation: {
      type: "behavior",
      path,
      export_name: fn,
      public_checks: checks
        .slice(0, 1)
        .map(([args, expected]) => ({ args, expected })),
      hidden_checks: checks
        .slice(1)
        .map(([args, expected]) => ({ args, expected })),
      timeout_seconds: 10,
    },
    allowed_changes: allowed,
    tags: [category],
    critical: false,
    ...options,
  });
  referencePatches[id] =
    path && fixed ? [{ repository, path, content: fixed }] : [];
}
add(
  1,
  "bug_fix",
  "medium",
  "fixture-payment-service",
  "refund.ts",
  "CalculateRefund",
  "Fix CalculateRefund to exclude previously refunded quantities and clamp negative remaining quantity.",
  [
    "Price is multiplied by remaining quantity",
    "Over-refunded quantity returns zero",
  ],
  [
    [[10, 2, 0], 20],
    [[10, 3, 1], 20],
    [[10, 1, 4], 0],
  ],
  'export function CalculateRefund(price, quantity, refunded) { return price * Math.max(0, quantity-refunded); }\nexport function FindRefundHandler() { return "refund"; }\n',
  { critical: true },
);
add(
  2,
  "state_transition",
  "hard",
  "fixture-alpha-service",
  "state.ts",
  "transition",
  "Allow pending → paid → shipped transitions only. Reject backwards and skipped transitions without changing state.",
  ["Legal transitions advance", "Illegal transitions preserve state"],
  [
    [["pending", "paid"], "paid"],
    [["shipped", "pending"], "shipped"],
    [["pending", "shipped"], "pending"],
  ],
  'export function transition(state,event) { const next={pending:"paid",paid:"shipped"}; return next[state]===event?event:state; }\n',
);
add(
  3,
  "api_change",
  "easy",
  "fixture-payment-service",
  "api.ts",
  "serializePayment",
  "Include currency in serializePayment without exposing internalSecret.",
  ["ID and currency are returned", "Internal fields are excluded"],
  [
    [[{ id: "p1" }], { id: "p1" }],
    [
      [{ id: "p2", currency: "USD", internalSecret: "fixture-only" }],
      { id: "p2", currency: "USD" },
    ],
  ],
  "export function serializePayment(p) { return p.currency ? {id:p.id,currency:p.currency} : {id:p.id}; }\n",
);
add(
  4,
  "query_optimization",
  "hard",
  "fixture-payment-service",
  "pagination.sql",
  "",
  "Replace offset pagination with an id keyset query using WHERE id > $1 ORDER BY id LIMIT $2. Do not concatenate values.",
  ["Bound cursor and limit parameters", "No OFFSET or full-table aggregation"],
  [],
  "SELECT id FROM payments WHERE id > $1 ORDER BY id LIMIT $2;\n",
  {
    validation: {
      type: "sql",
      path: "pagination.sql",
      public_checks: [],
      hidden_checks: [],
      timeout_seconds: 10,
    },
  },
);
add(
  5,
  "grpc_proto",
  "medium",
  "fixture-shared-proto",
  "payment.proto",
  "",
  "Add optional string currency field number 2 to Request. Keep the Payment.Charge RPC and existing field numbers.",
  [
    "Request.currency has tag 2",
    "Existing RPC request/response and id tag preserved",
  ],
  [],
  'syntax = "proto3"; package fixture.payment; message Request { string id = 1; string currency = 2; } message Reply { bool ok = 1; } service Payment { rpc Charge(Request) returns(Reply); }\n',
  {
    validation: {
      type: "proto",
      path: "payment.proto",
      public_checks: [],
      hidden_checks: [],
      timeout_seconds: 10,
    },
  },
);
add(
  6,
  "cross_repository",
  "hard",
  "fixture-payment-service",
  "client.ts",
  "requestPayment",
  "Update the shared Request currency contract and the payment client payload together. Preserve existing id callers.",
  ["Client sends currency", "Shared contract defines currency"],
  [
    [["p1"], { id: "p1" }],
    [["p2", "USD"], { id: "p2", currency: "USD" }],
  ],
  "export function requestPayment(id,currency) { return currency?{id,currency}:{id}; }\n",
  {
    repositories: ["fixture-payment-service", "fixture-shared-proto"],
    allowed_changes: [
      { repository: "fixture-payment-service", path: "client.ts" },
      { repository: "fixture-shared-proto", path: "payment.proto" },
    ],
  },
);
referencePatches["BENCH-006"].push({ ...referencePatches["BENCH-005"][0] });
add(
  7,
  "idempotency",
  "hard",
  "fixture-payment-service",
  "idempotency.ts",
  "chargeEvents",
  "Charge events at most once per idempotency key. Different keys must both contribute.",
  ["Duplicate keys are not charged twice", "Independent keys are charged"],
  [
    [[[{ key: "a", amount: 10 }]], 10],
    [
      [
        [
          { key: "a", amount: 10 },
          { key: "a", amount: 10 },
          { key: "b", amount: 5 },
        ],
      ],
      15,
    ],
  ],
  "export function chargeEvents(events) { const seen=new Set(); return events.reduce((sum,e)=>{ if(seen.has(e.key))return sum; seen.add(e.key); return sum+e.amount; },0); }\n",
  { critical: true },
);
add(
  8,
  "event_processing",
  "hard",
  "fixture-alpha-service",
  "events.ts",
  "applyEvent",
  "Apply only newer event versions. Duplicate and out-of-order events must preserve the latest state.",
  ["Newer events apply", "Older or duplicate events do not overwrite"],
  [
    [
      [
        { version: 1, value: "a" },
        { version: 2, value: "b" },
      ],
      { version: 2, value: "b" },
    ],
    [
      [
        { version: 3, value: "new" },
        { version: 2, value: "old" },
      ],
      { version: 3, value: "new" },
    ],
  ],
  "export function applyEvent(state,event) { return event.version>state.version?event:state; }\n",
);
add(
  9,
  "regression",
  "medium",
  "fixture-payment-service",
  "money.ts",
  "money",
  "Round monetary values to two decimals rather than truncating them. Preserve zero and negative amounts.",
  ["Round, do not truncate", "Zero and negative values retain their meaning"],
  [
    [[0], 0],
    [[1.236], 1.24],
    [[-1.236], -1.24],
  ],
  "export function money(amount) { return Math.round(amount * 100) / 100; }\n",
);
add(
  10,
  "clarification",
  "medium",
  "fixture-payment-service",
  "policy.ts",
  "refundPolicy",
  "Change refund policy. The request does not specify whether historical refunds should change; clarify before editing.",
  [
    "Ask about historical refunds before any edit",
    "After the supplied answer, affect future refunds only",
  ],
  [[[], "future"]],
  'export function refundPolicy() { return "future"; }\n',
  {
    clarification: {
      question:
        "Should historical refunds change, or should the policy affect future refunds only?",
      answer: "Future refunds only; preserve historical refunds.",
    },
  },
);
add(
  11,
  "avoid_n_plus_one",
  "hard",
  "fixture-alpha-service",
  "hydration.ts",
  "hydrateOrders",
  "Batch customer hydration in one query for all orders. Preserve order and duplicate-customer mappings.",
  ["One batch query", "Order and customer mapping are correct"],
  [],
  "export function hydrateOrders(orders,fetchBatch) { const customers=fetchBatch([...new Set(orders.map(o=>o.customerId))]); const byId=new Map(customers.map(c=>[c.id,c])); return orders.map(o=>({...o,customer:byId.get(o.customerId)})); }\n",
);
add(
  12,
  "transaction_consistency",
  "hard",
  "fixture-payment-service",
  "transaction.ts",
  "transfer",
  "Reject transfer to a closed account before debiting the sender. Insufficient balance must not partially mutate either account.",
  ["Valid transfer conserves total balance", "Rejected transfer is atomic"],
  [],
  "export function transfer(a,b,amount) { if(b.closed || a.balance<amount || amount<0)return false; a.balance-=amount; b.balance+=amount; return true; }\n",
  { critical: true },
);
add(
  13,
  "retry_recovery",
  "medium",
  "fixture-payment-service",
  "retry.ts",
  "retryValue",
  "Recover once from the synthetic transient worker failure, then implement retryValue returning true.",
  [
    "Only the declared transient failure is retried",
    "Final behavior is verified",
  ],
  [[[], true]],
  "export function retryValue() { return true; }\n",
  { transient_once: true },
);
add(
  14,
  "repository_discovery",
  "medium",
  "fixture-payment-service",
  "refund.ts",
  "FindRefundHandler",
  "Locate FindRefundHandler among similar services and select its repository. Do not change code.",
  ["Select the repository containing the exact definition"],
  [],
  "",
  {
    repositories: [
      "fixture-alpha-service",
      "fixture-payment-service",
      "fixture-shared-proto",
    ],
    allowed_changes: [],
    validation: {
      type: "navigation",
      path: "refund.ts",
      export_name: "FindRefundHandler",
      public_checks: [],
      hidden_checks: [],
      timeout_seconds: 10,
    },
  },
);
add(
  15,
  "snapshot_freshness",
  "medium",
  "fixture-payment-service",
  "freshness.ts",
  "SnapshotMarker",
  "Update SnapshotMarker from old to new, then retrieve context from the changed worktree without returning old source.",
  [
    "Updated implementation returns new",
    "Retrieved snippet belongs to the modified snapshot",
  ],
  [[[], "new"]],
  'export function SnapshotMarker() { return "new"; }\n',
  {
    validation: {
      type: "freshness",
      path: "freshness.ts",
      export_name: "SnapshotMarker",
      public_checks: [],
      hidden_checks: [{ args: [], expected: "new" }],
      timeout_seconds: 10,
    },
  },
);
export const caseTemplates = cases;
