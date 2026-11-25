import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool, q, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { registerInstance } from "../src/instances.ts";
import { repositories } from "../src/repos/service.ts";
import { definitions } from "../src/workflow/definitions.ts";
import { startRun } from "../src/workflow/engine.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";
import { buildFixProof, type FixProofReport } from "../src/agent/proofOfFix.ts";
import {
  captureFromProof,
  causalHistory,
  invalidateCausalMemories,
  recallCausal,
  rollbackCausal,
  setCausalStatus,
  upsertCausal,
  causalFromProof,
} from "../src/memory/causal.ts";

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env }).trim();
const REPO = "causal-pay";
let alice = 0,
  bob = 0,
  runId = 0,
  root = "",
  head = "";

function report(
  over: { verdict?: "VERIFIED" | "FAILED"; root?: string; title?: string; file?: string } = {},
): FixProofReport {
  const failed = over.verdict === "FAILED";
  return buildFixProof({
    upstream: {
      root_cause: {
        output: {
          root_cause_assessment: {
            status: "CONFIRMED",
            confidence: "high",
            explanation: over.root ?? "settlement reads the balance outside the transaction",
          },
          claims: [
            {
              id: "c1",
              claim: "read outside tx",
              classification: "CODE_FACT",
              source_type: "code",
              source_ref: `${REPO}@x`,
              repository: REPO,
              commit: head,
              file_path: over.file ?? "settle.go",
              line_range: "3-4",
              confidence: "high",
              verification_status: "verified",
              provenance: {
                by: "platform",
                status: "VERIFIED_BY_PLATFORM",
                verifies: "location",
                reason: null,
              },
            },
          ],
        },
      },
      implement: {
        output: {
          verification: { passed: !failed, last: [] },
          tested_heads: { [REPO]: head },
          regression_proof: {
            status: "verified",
            reason: "fails before",
            repo: REPO,
            test_id: "TestSettleTwice",
            head_sha: head,
          },
          remediation: {
            kind: failed ? "MITIGATION" : "ROOT_CAUSE_FIX",
            root_cause: "x",
            causal_link: failed
              ? "raise the settlement timeout to 60s"
              : "read the balance inside the transaction",
            justifications: [],
          },
        },
      },
      review: { output: { verdict: "PASS" } },
    },
    rootCauseFrom: "root_cause",
    implementFrom: "implement",
    reviewFrom: "review",
    reviewIndependent: true,
    incident: { title: over.title ?? "Settlement paid twice", request: "customers charged twice" },
  });
}
const capture = (r: FixProofReport, owner = alice) =>
  captureFromProof({
    ownerId: owner,
    runId,
    fixProofId: null,
    report: r,
    upstream: { implement: { output: { tested_heads: { [REPO]: head } } } },
    implementFrom: "implement",
  });

before(async () => {
  await migrate();
  await registerInstance();
  await shareAllRepositoriesForTests();
  alice = (
    await createUser({ username: "causal-alice", password: "causal-test-password", role: "member" })
  ).id;
  bob = (
    await createUser({ username: "causal-bob", password: "causal-test-password", role: "member" })
  ).id;
  root = join(config.reposRoot, REPO);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", config.baseBranch);
  writeFileSync(join(root, "settle.go"), "package pay\n\nfunc settle() {\n\tread()\n}\n");
  writeFileSync(join(root, "other.go"), "package pay\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  head = git(root, "rev-parse", "HEAD");
  await repositories.upsert(REPO, { projects: ["Causal"], default_branch: config.baseBranch });
  await definitions.create({
    key: "causal-wf",
    spec: { name: "causal", steps: [{ key: "x", type: "agent" }] },
  });
  const run = await startRun({
    definitionKey: "causal-wf",
    title: "Settlement paid twice",
    ownerId: alice,
    start: false,
    repositories: [REPO],
  });
  runId = Number(run.id);
});
after(async () => {
  await pool.end();
});

test("a verified outcome is recalled for a relevant future task, with a private knowledge proposal for review", async () => {
  const res = await capture(report());
  assert.equal(res.row.status, "verified");
  const recall = await recallCausal(alice, {
    text: "customers were charged twice by settlement",
    repositories: [REPO],
  });
  assert.equal(recall.items[0]?.id, res.row.id);
  assert.equal(recall.items[0].authoritative, true);
  assert.match(
    recall.items[0].text,
    /Root cause: settlement reads the balance outside the transaction/,
  );
  assert.match(recall.items[0].text, /Regression tests: TestSettleTwice/);
  const proposal = await one(
    pool,
    "SELECT owner_id, status, change_type FROM knowledge_proposals WHERE id=$1",
    [
      (await one(pool, "SELECT knowledge_proposal_id FROM causal_memories WHERE id=$1", [
        res.row.id,
      ]))!.knowledge_proposal_id,
    ],
  );
  assert.ok(proposal, "a knowledge proposal was created");
  assert.equal(
    Number(proposal!.owner_id),
    alice,
    "private: never published to the shared scope automatically",
  );
  assert.equal(proposal!.status, "pending", "publication follows the existing review");
});

test("private memory never leaks to another user", async () => {
  const r = await recallCausal(bob, {
    text: "customers were charged twice by settlement",
    repositories: [REPO],
    errorSignatures: ["settlement paid twice"],
  });
  assert.deepEqual(r.items, []);
  await assert.rejects(causalHistory(bob, 1), /not found/);
});

test("a failed approach is kept as negative knowledge and returned as a caution, not as authority", async () => {
  await capture(
    report({
      verdict: "FAILED",
      title: "Settlement timeout spikes",
      root: "connection pool exhausted under load",
    }),
  );
  const r = await recallCausal(alice, {
    text: "settlement timeout spikes raise timeout",
    repositories: [REPO],
  });
  const caution = r.items.find((i) => i.negative)!;
  assert.ok(caution, "the failed approach is retrievable");
  assert.equal(caution.authoritative, false);
  assert.match(caution.text, /CAUTION — failed approach/);
  assert.match(caution.text, /Did NOT work: MITIGATION: raise the settlement timeout to 60s/);
});

test("a contradicting verified root cause demotes the record; human correction and rollback keep full history", async () => {
  const contradicted = await upsertCausal(
    alice,
    causalFromProof({
      // A genuinely different cause cites different evidence (a paraphrase citing the same code would corroborate).
      report: report({ root: "the payment provider sends duplicate webhooks", file: "webhook.go" }),
      repositories: [REPO],
      testedHeads: { [REPO]: head },
      errorSignatures: ["Settlement paid twice"],
      services: [],
      runId,
      fixProofId: null,
    }),
  );
  assert.equal(contradicted.change, "contradicted");
  assert.equal(
    contradicted.row.status,
    "proposed",
    "neither explanation stays authoritative until a human decides",
  );
  assert.match(JSON.stringify(contradicted.row.provenance), /duplicate webhooks/);
  const corrected = await setCausalStatus(
    alice,
    contradicted.row.id,
    "verified",
    "webhook dedupe confirmed in provider logs",
  );
  assert.equal(corrected.status, "verified");
  await assert.rejects(
    setCausalStatus(bob, contradicted.row.id, "rejected", "not mine"),
    /not found/,
  );
  const rolled = await rollbackCausal(alice, contradicted.row.id, 1);
  assert.equal(rolled.root_cause, "settlement reads the balance outside the transaction");
  const h = await causalHistory(alice, contradicted.row.id);
  assert.deepEqual(
    h.versions.map((v) => v.version),
    [1, 2, 3, 4],
  );
  assert.match(h.versions[3].change, /rollback to version 1/);
  assert.ok(
    (await q(pool, "SELECT 1 FROM audit_log WHERE action='causal_memory.status'")).length >= 1,
  );
});

test("a code change in the validity boundary makes the record outdated; outdated records are not authoritative", async () => {
  writeFileSync(join(root, "settle.go"), "package pay\n\nfunc settle() {\n\ttx(read)\n}\n");
  git(root, "commit", "-qam", "change settle");
  const r = await invalidateCausalMemories();
  assert.ok(r.outdated >= 1);
  const byDefault = await recallCausal(alice, {
    text: "customers were charged twice by settlement",
    repositories: [REPO],
  });
  assert.ok(
    !byDefault.items.some((i) => i.status === "outdated"),
    "outdated records are excluded by default",
  );
  const withOld = await recallCausal(alice, {
    text: "customers were charged twice by settlement",
    repositories: [REPO],
    includeOutdated: true,
  });
  const old = withOld.items.find((i) => i.status === "outdated")!;
  assert.equal(old.authoritative, false);
  assert.match(old.text, /OUTDATED \(cited files changed: causal-pay:settle.go\)/);
});

test("losing repository access withholds the records about it", async () => {
  await q(pool, "UPDATE repositories SET shared_access='none' WHERE name=$1", [REPO]);
  try {
    const r = await recallCausal(alice, {
      text: "settlement timeout spikes",
      includeOutdated: true,
    });
    assert.deepEqual(r.items, []);
  } finally {
    await q(pool, "UPDATE repositories SET shared_access='pull_request' WHERE name=$1", [REPO]);
  }
});

test("retrieval relevance and token overhead on a seeded memory set", async () => {
  const topics = [
    [
      "inventory reservation double counted",
      "inventory.go",
      "reservations are counted twice on retry",
    ],
    [
      "shipment status stuck in packed",
      "shipment.go",
      "carrier callback ignored for packed orders",
    ],
    ["voucher applied twice", "voucher.go", "voucher redemption is not idempotent"],
    ["order export times out", "export.go", "export query has no index on created_at"],
    ["refund webhook rejected", "webhook.go", "signature check uses the wrong secret"],
    ["cart total rounding error", "cart.go", "float arithmetic on money amounts"],
    ["login token expires early", "auth.go", "clock skew between services"],
    ["kafka consumer lag grows", "consumer.go", "commit offsets after each message"],
  ];
  const ids: number[] = [];
  for (const [title, file, cause] of topics) {
    const m = causalFromProof({
      report: report({ title, root: cause, file }),
      repositories: [REPO],
      testedHeads: { [REPO]: head },
      errorSignatures: [title],
      services: [],
      runId,
      fixProofId: null,
    });
    ids.push((await upsertCausal(alice, m)).row.id);
  }
  const queries: Array<[Parameters<typeof recallCausal>[1], number]> = topics.map(
    ([title, file], i) => [
      i % 2
        ? { text: title.split(" ").slice(0, 3).join(" ") }
        : { files: [file], text: "investigate" },
      ids[i],
    ],
  );
  let rr = 0,
    top1 = 0,
    tokens = 0;
  for (const [query, expected] of queries) {
    const r = await recallCausal(alice, {
      ...query,
      repositories: [REPO],
      limit: 3,
      tokenBudget: 400,
    });
    const rank = r.items.findIndex((i) => i.id === expected);
    if (rank === 0) top1++;
    if (rank >= 0) rr += 1 / (rank + 1);
    tokens += r.tokens_estimate;
    assert.ok(r.tokens_estimate <= 400, "token budget respected");
  }
  const mrr = rr / queries.length;
  console.log(
    `causal recall: precision@1 ${(top1 / queries.length).toFixed(2)}, MRR ${mrr.toFixed(2)}, mean context ${Math.round(tokens / queries.length)} tokens`,
  );
  assert.ok(top1 / queries.length >= 0.85, "relevant memory ranks first");
});

test("lifecycle edge cases: paraphrase, open contradiction, concurrent capture, unmerged branch, retraction, rollback", async () => {
  const mk = (root: string, file = "ledger.go", title = "Ledger drift") =>
    causalFromProof({
      report: report({ root, file, title }),
      repositories: [REPO],
      testedHeads: { [REPO]: head },
      errorSignatures: [title],
      services: [],
      runId,
      fixProofId: null,
    });
  // Concurrent first captures of one key: both succeed, one row, two versions.
  const [a, b] = await Promise.all([
    upsertCausal(alice, mk("ledger rows written twice on retry")),
    upsertCausal(alice, mk("ledger rows written twice on retry")),
  ]);
  assert.equal(a.row.id, b.row.id);
  assert.deepEqual([a.change, b.change].sort(), ["corroborated", "created"]);
  // A paraphrase citing the same evidence corroborates, it does not contradict.
  const para = await upsertCausal(alice, mk("retry writes the ledger row a second time"));
  assert.equal(para.change, "corroborated");
  assert.equal(para.row.status, "verified");
  // A different cause with different evidence opens a contradiction; the next verified run cannot close it.
  const contra = await upsertCausal(alice, mk("clock skew between ledger shards", "shard.go"));
  assert.equal(contra.change, "contradicted");
  const again = await upsertCausal(alice, mk("clock skew between ledger shards", "shard.go"));
  assert.equal(again.row.status, "proposed", "an open contradiction is a human decision");
  const resolved = await setCausalStatus(
    alice,
    again.row.id,
    "verified",
    "shard clocks confirmed in traces",
  );
  assert.equal(resolved.status, "verified");
  assert.equal(
    (resolved.provenance as { contradiction?: { unresolved?: boolean } }).contradiction?.unresolved,
    undefined,
  );
  // Rollback restores invalidation fields and is audited.
  await setCausalStatus(alice, resolved.id, "outdated", "superseded by a refactor");
  const back = await rollbackCausal(alice, resolved.id, 1);
  assert.equal(back.status, "verified");
  assert.equal(
    (await one(pool, "SELECT invalidated_at FROM causal_memories WHERE id=$1", [resolved.id]))!
      .invalidated_at,
    null,
  );
  assert.ok(
    (
      await q(
        pool,
        "SELECT 1 FROM audit_log WHERE action='causal_memory.rollback' AND resource_id=$1",
        [String(resolved.id)],
      )
    ).length,
  );
  await assert.rejects(rollbackCausal(alice, resolved.id, Number("abc")), /positive integer/);
});

test("an unmerged fix branch does not make its own memory outdated; a contradiction retracts the pending proposal", async () => {
  // Fix on a branch: tested head differs from base in the cited file, base itself unchanged.
  git(root, "checkout", "-q", "-b", "fix/branch");
  writeFileSync(join(root, "branch.go"), "package pay\n\nfunc fixed() {}\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fix on branch");
  const branchHead = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", config.baseBranch);
  const saved = head;
  head = branchHead;
  try {
    const res = await capture(
      report({
        title: "Branch fix incident",
        root: "branch-only cause in fixed()",
        file: "branch.go",
      }),
    );
    assert.notEqual(
      (res.row.validity as { commits: Record<string, string> }).commits[REPO],
      branchHead,
      "validity pinned to the merge base",
    );
    const r = await invalidateCausalMemories(500);
    assert.ok(r.checked >= 1);
    assert.equal(
      (await one(pool, "SELECT status FROM causal_memories WHERE id=$1", [res.row.id]))!.status,
      "verified",
    );
    // A contradicting verified outcome retracts the still-pending knowledge proposal.
    const contra = await upsertCausal(
      alice,
      causalFromProof({
        report: report({
          title: "Branch fix incident",
          root: "unrelated cache eviction storm",
          file: "cache.go",
        }),
        repositories: [REPO],
        testedHeads: { [REPO]: branchHead },
        errorSignatures: ["Branch fix incident"],
        services: [],
        runId,
        fixProofId: null,
      }),
    );
    assert.equal(contra.change, "contradicted");
    const pid = (await one(pool, "SELECT knowledge_proposal_id FROM causal_memories WHERE id=$1", [
      res.row.id,
    ]))!.knowledge_proposal_id;
    assert.ok(pid);
    assert.equal(
      (await one(pool, "SELECT status FROM knowledge_proposals WHERE id=$1", [pid]))!.status,
      "obsolete",
    );
  } finally {
    head = saved;
  }
});
