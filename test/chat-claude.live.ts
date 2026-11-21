/**
 * Real Claude through the chat runtime (no provider stub): native MCP tool calls → platform authorization → tools →
 * results → answer, with streaming. Uses the configured Claude account (spends its usage): opt in with CHAT_LIVE=1.
 * Read-only prompts on the disposable test database; the "remote" repository is materialized locally.
 *
 *   CHAT_LIVE=1 node --import ./test/setup.ts --test test/chat-claude.live.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pool, q } from "../src/db/pool.ts";
import { createUser } from "../src/auth/users.ts";
import { chat } from "../src/chat/service.ts";
import { chatRepository } from "../src/chat/repository.ts";
import { setChatTitleComplete } from "../src/chat/title.ts";
import { setChatMaterializerForTests } from "../src/chat/sourceAccess.ts";
import { registerBuiltinTools } from "../src/agent/toolRegistry.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";
import type { Actor } from "../src/authz/access.ts";

const live = process.env.CHAT_LIVE === "1";
let owner: Actor;

before(async () => {
  if (!live) return;
  await shareAllRepositoriesForTests();
  registerBuiltinTools(); // the server registers the shared integration tools at startup
  const u = await createUser({
    username: `live-${Date.now()}`,
    password: "local-test-password",
    role: "member",
  });
  owner = { id: u.id, username: u.username, role: u.role as Actor["role"], active: u.active };
  await q(
    pool,
    `INSERT INTO repositories (name, provider, remote_slug, projects, repository_url, shared_access)
     VALUES ('payment-api', 'bitbucket', 'team/payment-api', '{Payment}', 'https://bitbucket.org/team/payment-api.git', 'pull_request')
     ON CONFLICT (name) DO NOTHING`,
  );
  setChatMaterializerForTests(async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-src-"));
    writeFileSync(
      join(dir, "go.mod"),
      "module payment\n\ngo 1.22\n\nrequire github.com/segmentio/kafka-go v0.4.47\n",
    );
    writeFileSync(join(dir, "Dockerfile"), "FROM golang:1.22\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    return dir;
  });
  setChatTitleComplete(async () => "live"); // no extra model call for the title
});
after(async () => {
  if (!live) return;
  setChatTitleComplete(undefined);
  setChatMaterializerForTests(null);
  await settleBackground();
  await pool.end();
});

async function turn(content: string) {
  const c = await chat.create(owner, {
    mode: "INVESTIGATE",
    provider: "claude",
    provider_strategy: "manual",
  });
  const t0 = Date.now();
  await chat.postMessage(owner, c.id, { content, client_message_id: `live-${c.id}-${t0}` });
  // Delta events are pruned when the turn completes (repository.ts): count them while it runs.
  let deltas = 0;
  for (;;) {
    const [row] = await q<{ n: number; status: string }>(
      pool,
      `SELECT (SELECT count(*)::int FROM chat_events WHERE conversation_id = $1 AND kind = 'response.delta') AS n,
              (SELECT status FROM chat_turns WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1) AS status`,
      [c.id],
    );
    deltas = Math.max(deltas, row.n);
    if (row.status !== "running" && row.status !== "queued") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await settleBackground();
  const d = await chat.get(owner, c.id);
  const calls = await chatRepository.toolCallsOf(c.id);
  const log = calls.map((r) => ({ tool: r.tool, status: r.status, ms: r.duration_ms }));
  console.log(
    JSON.stringify({ turn_ms: Date.now() - t0, status: d.turns[0].status, tools: log, deltas }),
  );
  return { d, calls, deltas };
}

test(
  "real Claude: sequential native tool calls, real tool results, streamed answer",
  { skip: !live, timeout: 100_000 },
  async () => {
    const r = await turn(
      "Dùng tool code.list_files cho repository payment-api, rồi đọc go.mod bằng code.read_file. Trả lời đúng một câu: ngôn ngữ và message broker, kèm [tool #n].",
    );
    assert.equal(r.d.turns[0].status, "completed");
    const ok = r.calls.filter((c) => c.status === "ok").map((c) => c.tool);
    assert.ok(
      ok.includes("code.list_files") && ok.includes("code.read_file"),
      `tools: ${ok.join(", ")}`,
    );
    assert.ok(r.deltas > 0, "the answer streamed");
    const answer = r.d.messages.at(-1)!.content;
    assert.match(answer, /Go/i);
    assert.match(answer, /kafka/i);
    const raw = JSON.stringify(r.calls.map((c) => c.result));
    assert.ok(
      !raw.includes(process.env.AUTH_SECRET ?? "\u0000none"),
      "no platform secret in tool results",
    );
  },
);

test(
  "real Claude: discovers integrations and reports their real availability",
  { skip: !live, timeout: 100_000 },
  async () => {
    const r = await turn(
      "Dùng tools.search tìm tool Splunk hoặc Kafka và cho biết trong 1 câu tool nào đang khả dụng, tool nào chưa kết nối.",
    );
    assert.equal(r.d.turns[0].status, "completed");
    assert.ok(
      r.calls.some((c) => c.tool === "tools.search" && c.status === "ok"),
      "tools.search ran",
    );
    assert.match(r.d.messages.at(-1)!.content, /kết nối|connect|khả dụng|available/i);
  },
);
