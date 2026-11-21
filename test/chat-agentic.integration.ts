/**
 * Project-aware chat: image attachments (upload validation, ownership, binding to a message, image-only messages,
 * capability routing), repository scope inferred from the request, source access through a registered remote when no
 * checkout exists, and native tool calls (mocked Claude) going through the same authorized chat tool path.
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
import { setChatProviders } from "../src/chat/runtime.ts";
import { setChatHealthProbe } from "../src/chat/admission.ts";
import { setChatTitleComplete } from "../src/chat/title.ts";
import { readAttachment, uploadAttachment } from "../src/chat/attachments.ts";
import { setChatMaterializerForTests } from "../src/chat/sourceAccess.ts";
import { settleBackground } from "../src/workflow/background.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";
import type { Actor } from "../src/authz/access.ts";
import type { CompletionRunner } from "../src/agent/complete.ts";

const PROVIDERS = ["claude", "cursor", "codex", "antigravity", "copilot"] as const;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
let owner: Actor;
let other: Actor;
let seen: { images: number; native: string[]; text: string } = { images: 0, native: [], text: "" };

/** Claude stub with native tools: lists the inferred repositories and the manifests of one, then answers. */
const claude: CompletionRunner = async (prompt, opts) => {
  seen = { images: opts.images?.length ?? 0, native: [], text: prompt };
  if (opts.nativeTools) {
    for (const [name, args] of [
      ["repo.list", {}],
      ["code.list_files", { repository: "payment-api" }],
      ["code.read_file", { repository: "secret-repo", path: "x" }],
    ] as const) {
      seen.native.push(await opts.nativeTools.call(name, args));
    }
  }
  return { text: "Payment uses Go (go.mod) [tool #2].", model: "stub", tokens: null };
};
const textOnly: CompletionRunner = async () => ({ text: "ok", model: "stub", tokens: null });

before(async () => {
  await shareAllRepositoriesForTests();
  const mk = async (tag: string) => {
    const u = await createUser({ username: `agentic-${tag}-${Date.now()}`, password: "local-test-password", role: "member" });
    return { id: u.id, username: u.username, role: u.role as Actor["role"], active: u.active };
  };
  owner = await mk("owner");
  other = await mk("other");
  await q(
    pool,
    `INSERT INTO repositories (name, provider, remote_slug, projects, description, repository_url, shared_access)
     VALUES ('payment-api', 'bitbucket', 'team/payment-api', '{Payment}', 'Payment gateway API', 'https://bitbucket.org/team/payment-api.git', 'pull_request'),
            ('payment-wiki', 'bitbucket', 'team/payment-wiki', '{Payment}', 'Payment documentation', 'https://bitbucket.org/team/payment-wiki.git', 'pull_request'),
            ('oms-core', 'bitbucket', 'team/oms-core', '{OMS}', 'Order management', 'https://bitbucket.org/team/oms-core.git', 'pull_request')
     ON CONFLICT (name) DO NOTHING`,
  );
  // No checkout exists: the registered remote is "prepared" into a small git repository.
  setChatMaterializerForTests(async () => {
    const dir = mkdtempSync(join(tmpdir(), "chat-src-"));
    writeFileSync(join(dir, "go.mod"), "module payment\n\ngo 1.22\n");
    writeFileSync(join(dir, "main.go"), "package main\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "."], { cwd: dir });
    return dir;
  });
  setChatHealthProbe(async () => PROVIDERS.map((provider) => ({ provider, connected: true, quota: "unknown" as const })));
  setChatTitleComplete(async () => "title");
  setChatProviders({ claude, cursor: textOnly, codex: textOnly, antigravity: textOnly, copilot: textOnly });
});
after(async () => {
  setChatProviders(undefined);
  setChatHealthProbe(undefined);
  setChatTitleComplete(undefined);
  setChatMaterializerForTests(null);
  await settleBackground();
  await pool.end();
});

test("uploads: type from the bytes, size bounds, base64 only, owner's conversation only", async () => {
  const c = await chat.create(owner, { mode: "ASK", provider: "claude" });
  const ok = await uploadAttachment(owner.id, c.id, { data: PNG.toString("base64") });
  assert.equal(ok.media_type, "image/png");
  const gif = Buffer.from("R0lGODlhAQABAAAAACw=", "base64");
  await assert.rejects(uploadAttachment(owner.id, c.id, { data: gif.toString("base64") }), /PNG, JPEG and WebP/);
  // A PNG name or claim does not matter: the bytes decide (plain text is a text document, binary is refused).
  const text = await uploadAttachment(owner.id, c.id, { data: Buffer.from("not an image").toString("base64"), filename: "x.png" });
  assert.equal(text.kind, "document");
  assert.equal(text.media_type, "text/plain");
  await assert.rejects(
    uploadAttachment(owner.id, c.id, { data: Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0]).toString("base64"), filename: "x.png" }),
    /PNG, JPEG and WebP/,
  );
  await assert.rejects(uploadAttachment(owner.id, c.id, { data: "%%%" }), /not base64/);
  await assert.rejects(uploadAttachment(owner.id, c.id, { data: "A".repeat(14 * 1024 * 1024) }), /larger than/);
  // A valid PNG above the image limit (5 MB) is refused even though documents may be larger.
  const bigPng = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
  await assert.rejects(uploadAttachment(owner.id, c.id, { data: bigPng.toString("base64") }), /image larger than 5 MB/);
  await assert.rejects(uploadAttachment(other.id, c.id, { data: PNG.toString("base64") }), /not found/);
  assert.ok(await readAttachment(owner.id, ok.id));
  assert.equal(await readAttachment(other.id, ok.id), undefined, "another user never reads it");
  // Another user's upload id cannot be attached to this conversation's message.
  const theirs = await chat.create(other, { mode: "ASK", provider: "claude" });
  const foreign = await uploadAttachment(other.id, theirs.id, { data: PNG.toString("base64") });
  await assert.rejects(
    chat.postMessage(owner, c.id, { content: "look", attachments: [foreign.id], client_message_id: `agentic-f-${c.id}` }),
    /not found or already used/,
  );
  await assert.rejects(chat.postMessage(owner, c.id, { content: "  " }), /text or at least one image/);
});

test("an image-only message reaches the vision provider and stays in the history; a manual text-only provider is refused", async () => {
  const c = await chat.create(owner, { mode: "ASK", provider: "claude" });
  const up = await uploadAttachment(owner.id, c.id, { data: PNG.toString("base64") });
  const posted = await chat.postMessage(owner, c.id, { attachments: [up.id], client_message_id: `agentic-img-${c.id}` });
  assert.equal(posted.message?.content, "");
  await settleBackground();
  assert.equal(seen.images, 1, "the image was sent as an image block");
  const detail = await chat.get(owner, c.id);
  const user = detail.messages.find((m) => m.role === "user")!;
  assert.deepEqual(user.attachments.map((a) => a.id), [up.id]);
  assert.equal(detail.turns[0].status, "completed");
  // A follow-up without a new image still carries the screenshot (bounded window).
  await chat.postMessage(owner, c.id, { content: "và lỗi này nghĩa là gì?", client_message_id: `agentic-img2-${c.id}` });
  await settleBackground();
  assert.equal(seen.images, 1);

  const manual = await chat.create(owner, { mode: "ASK", provider: "codex", provider_strategy: "manual" });
  const img = await uploadAttachment(owner.id, manual.id, { data: PNG.toString("base64") });
  await chat.postMessage(owner, manual.id, { content: "phân tích", attachments: [img.id], client_message_id: `agentic-cap-${manual.id}` });
  await settleBackground();
  const turn = (await chat.get(owner, manual.id)).turns[0] as { status: string; failure?: { code?: string } };
  assert.equal(turn.status, "failed");
  assert.equal(turn.failure?.code, "PROVIDER_CAPABILITY", "never a silently dropped image");
});

test("repository scope inferred from the request; native tool calls use the authorized chat tools and the remote checkout", async () => {
  const c = await chat.create(owner, { mode: "INVESTIGATE", provider: "claude" });
  await chat.postMessage(owner, c.id, { content: "Techstack Payment gồm những gì?", client_message_id: `agentic-repo-${c.id}` });
  await settleBackground();
  const events = await q<{ data: { repositories: Array<{ name: string }> } }>(
    pool,
    "SELECT data FROM chat_events WHERE conversation_id = $1 AND kind = 'repositories.resolved'",
    [c.id],
  );
  assert.deepEqual(events[0].data.repositories.map((r) => r.name).sort(), ["payment-api", "payment-wiki"]);
  assert.match(seen.text, /Repository scope: payment-api, payment-wiki/);
  assert.equal(seen.native.length, 3, "the provider called the platform tools natively");
  assert.match(seen.native[1], /go\.mod/, "manifests listed from the checkout prepared from the registered remote");
  assert.match(seen.native[2], /denied/, "an unreadable repository is refused by the same authorization");
  const calls = await chatRepository.toolCallsOf(c.id);
  assert.deepEqual(calls.map((r) => [r.tool, r.status]), [
    ["repo.list", "ok"],
    ["code.list_files", "ok"],
    ["code.read_file", "denied"],
  ]);
  const detail = await chat.get(owner, c.id);
  assert.equal(detail.turns[0].status, "completed");
  assert.match(detail.messages.at(-1)!.content, /Go/);
});
