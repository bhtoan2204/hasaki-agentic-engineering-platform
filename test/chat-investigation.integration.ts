/**
 * Incident investigation started and followed from the chat (the workflow is kept; the chat is the entry point):
 *  - an "investigation" delegation selects the read-only production investigation workflow, never a coding workflow;
 *  - it starts through the existing preview → confirmed hash → work item + run path;
 *  - the conversation's runs endpoint reports progress and, once the workflow reported, the platform's conclusion
 *    (not the chat's), and only to the conversation's owner.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, one, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createUser } from "../src/auth/users.ts";
import { seedTemplates } from "../src/workflow/definitions.ts";
import { chat } from "../src/chat/service.ts";
import { setChatHealthProbe } from "../src/chat/admission.ts";
import { setChatTitleComplete } from "../src/chat/title.ts";
import { settleBackground } from "../src/workflow/background.ts";
import type { Actor } from "../src/authz/access.ts";

const PROVIDERS = ["claude", "cursor", "codex", "antigravity", "copilot"] as const;
let owner: Actor;
let other: Actor;

before(async () => {
  await migrate();
  await seedTemplates();
  const mk = async (tag: string) => {
    const u = await createUser({
      username: `chat-inv-${tag}-${Date.now()}`,
      password: "local-test-password",
      role: "member",
    });
    return { id: u.id, username: u.username, role: u.role as Actor["role"], active: u.active };
  };
  owner = await mk("owner");
  other = await mk("other");
  setChatHealthProbe(async () =>
    PROVIDERS.map((provider) => ({ provider, connected: true, quota: "unknown" as const })),
  );
  setChatTitleComplete(async () => "title");
});
after(async () => {
  setChatHealthProbe(undefined);
  setChatTitleComplete(undefined);
  await settleBackground();
  await pool.end();
});

test("an investigation from the chat runs the read-only investigation workflow and its verified result comes back to the chat", async () => {
  const c = (await chat.create(owner, { mode: "ASK", provider: "codex" })) as { id: number };
  await q(
    pool,
    "INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1,'user',$2), ($1,'assistant',$3)",
    [
      c.id,
      "Đơn SO123 bị tạo shipment chậm 40 giây lúc 10:05 hôm nay trên production, kiểm tra giúp nguyên nhân",
      "Có vẻ là partner phản hồi chậm; cần xem log và trace để xác nhận.",
    ],
  );
  const preview = (await chat.delegationPreview(owner, c.id, { kind: "investigation" })) as {
    hash: string;
    workflow: { key: string } | null;
    source_message_id: number;
    title: string;
    repositories: string[];
  };
  assert.equal(preview.workflow?.key, "production-incident-investigation");
  const started = (await chat.delegationExecute(owner, c.id, {
    request: {
      workflow: preview.workflow!.key,
      title: preview.title,
      repositories: preview.repositories,
      message_id: preview.source_message_id,
    },
    hash: preview.hash,
    confirmed: true,
  })) as { run_id: number | null; run_error: string | null };
  assert.ok(started.run_id, started.run_error ?? "run created");
  const run = await one<{ definition_key: string; inputs: { chat_conversation_id: number } }>(
    pool,
    "SELECT definition_key, inputs FROM workflow_runs WHERE id=$1",
    [started.run_id],
  );
  assert.equal(run!.definition_key, "production-incident-investigation");
  assert.equal(run!.inputs.chat_conversation_id, c.id);

  // While it runs: progress from the workflow's own steps; no conclusion yet.
  let runs = (await chat.delegations(owner, c.id)).delegations;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].definition_key, "production-incident-investigation");
  assert.ok(runs[0].progress.total > 3);
  assert.equal(runs[0].result, null);

  // The workflow reports (its report step completes): the chat shows the platform's conclusion.
  await q(
    pool,
    `UPDATE workflow_steps SET status='COMPLETED', output=$2 WHERE run_id=$1 AND config->>'action'='investigation_report'`,
    [
      started.run_id,
      JSON.stringify({
        summary: "Partner API responded in 38 s (trace t-1); retries are not the cause.",
        status: "root_cause_identified",
        report_markdown: "## Kết luận\nPartner chậm.",
      }),
    ],
  );
  runs = (await chat.delegations(owner, c.id)).delegations;
  assert.equal(
    runs[0].result?.summary,
    "Partner API responded in 38 s (trace t-1); retries are not the cause.",
  );
  assert.equal(runs[0].result?.status, "root_cause_identified");
  assert.match(String(runs[0].result?.markdown), /Partner chậm/);

  // Another user cannot read the conversation's runs.
  await assert.rejects(chat.delegations(other, c.id), /not found/);
});

test("an investigation request never maps to a coding workflow", async () => {
  const c = (await chat.create(owner, { mode: "ASK", provider: "codex" })) as { id: number };
  await q(
    pool,
    "INSERT INTO chat_messages (conversation_id, role, content) VALUES ($1,'user',$2)",
    [c.id, "fix the refund bug and open a PR"],
  );
  const preview = (await chat.delegationPreview(owner, c.id, { kind: "investigation" })) as {
    workflow: { key: string } | null;
  };
  assert.notEqual(preview.workflow?.key, "bug-investigation");
  assert.ok(
    ["production-incident-investigation", "incident-investigation"].includes(
      String(preview.workflow?.key),
    ),
  );
});
