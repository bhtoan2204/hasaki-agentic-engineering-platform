import { createHash } from "node:crypto";
import { pool, q, one, withTx, type Db } from "../db/pool.ts";
import { chatRepository } from "../chat/repository.ts";
import { withholdRevoked } from "../chat/runtime.ts";
import { readableRepositories } from "../chat/tools.ts";
import { buildDelegationPreview, executeDelegation } from "../chat/delegation.ts";
import { operationProvenance } from "../chat/operations.ts";
import { AUTONOMOUS_ACTIONS, attachAutonomousRun, decideChatAutonomy } from "../chat/autonomy.ts";
import { isPublicHttps } from "../telegram.ts";
import { botKey, preview, safeTelegramText, TELEGRAM_TEXT_MAX, textLimit } from "./client.ts";
import {
  opaqueId,
  preferences,
  queue,
  type OutboxLink,
  type TelegramPreferences,
} from "./store.ts";
import {
  conversationUrl,
  inQuietHours,
  runUrl,
  severityAllowed,
  STATUS_ICON,
  telegramAnswer,
  tr,
  type Severity,
} from "./format.ts";
import { log } from "../logging.ts";

/**
 * Outbound half of the gateway, driven by the elected receiver loop. Everything is state-based and keyed: a crash or a
 * second pass re-derives the same outbox dedupe keys, so nothing is sent twice and nothing is lost.
 *  - chat turns of the linked conversation: an edited status message while running, then the answer, pending
 *    operations and delegation proposals with buttons (or the autonomy policy's decision);
 *  - runs of bound users: a snapshot diff becomes deduplicated notifications, watched runs get one edited status message;
 *  - notifications are buffered, aggregated per user and held during quiet hours (critical ones are sent silently).
 */

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const TURN_EDIT_MS = 3000;
const RUN_EDIT_MS = 5000;
const AGGREGATE_MS = 20_000;
const RUN_SWEEP_MS = 10_000;
export const RUN_ACTIVE_STATUSES = ["PENDING", "RUNNING", "WAITING", "PAUSED"];
const PHASE_LABEL: Record<string, [string, string]> = {
  routing: ["chọn cách xử lý", "routing"],
  validating_provider: ["chọn cách xử lý", "routing"],
  switching_provider: ["đổi nhà cung cấp", "switching providers"],
  preparing_context: ["đọc ngữ cảnh", "reading context"],
  calling_provider: ["soạn trả lời", "writing the answer"],
  receiving_response: ["soạn trả lời", "writing the answer"],
  executing_tools: ["tra cứu", "looking things up"],
};

interface LinkRow {
  user_id: number;
  conversation_id: number;
  delivered_turn_id: string | number;
  chat_id: string;
  telegram_user_id: string;
}
const links = (db: Db = pool) =>
  q<LinkRow>(
    db,
    `SELECT l.user_id,l.conversation_id,l.delivered_turn_id,b.chat_id,b.telegram_user_id
       FROM telegram_chat_links l JOIN telegram_bindings b ON b.user_id=l.user_id AND b.bot_key=l.bot_key
       JOIN users u ON u.id=l.user_id AND u.active JOIN chat_conversations c ON c.id=l.conversation_id
      WHERE l.bot_key=$1 ORDER BY l.updated_at DESC LIMIT 500`,
    [botKey()],
  );

/** True while a linked conversation has a turn running or undelivered: the receiver then polls Telegram briefly. */
export async function gatewayBusy() {
  return !!(await one(
    pool,
    `SELECT 1 FROM telegram_chat_links l JOIN chat_turns t ON t.conversation_id=l.conversation_id
      WHERE l.bot_key=$1 AND (t.status IN ('queued','running') OR t.id>l.delivered_turn_id) LIMIT 1`,
    [botKey()],
  ));
}

// ---------------------------------------------------------------- chat turns

async function statusMessage(db: Db, link: LinkRow, turnId: number) {
  return one<{
    chat_id: string;
    message_id: number;
    last_text_hash: string | null;
    edited_at: string | null;
  }>(
    db,
    "SELECT chat_id,message_id,last_text_hash,edited_at FROM telegram_messages WHERE bot_key=$1 AND turn_id=$2 AND user_id=$3 AND chat_id=$4 AND kind='turn_status' LIMIT 1 FOR UPDATE",
    [botKey(), turnId, link.user_id, link.chat_id],
  );
}

export async function editTracked(
  db: Db,
  m: { chat_id: string; message_id: number; last_text_hash: string | null },
  userId: number,
  text: string,
  keyPrefix: "turn_progress" | "turn_final" | "run_status",
  keyboard?: unknown[][],
  link?: OutboxLink,
) {
  const payload = {
    chat_id: m.chat_id,
    message_id: m.message_id,
    text: preview(text),
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  };
  const h = hash(JSON.stringify([payload.text, keyboard ?? null, link?.kind ?? null]));
  if (m.last_text_hash === h) return;
  // Replace a pending edit in place so it keeps its delivery backoff and cannot overwrite newer content.
  const replaced = await one(
    db,
    `WITH pending AS (
      SELECT id,next_at FROM telegram_outbox
      WHERE bot_key=$1 AND user_id=$2 AND status='pending' AND dedupe_key LIKE ANY($3)
        AND payload->>'message_id'=$6 AND payload->>'chat_id'=$7 FOR UPDATE
    ), retained AS (SELECT min(id) AS id,max(next_at) AS next_at FROM pending)
    UPDATE telegram_outbox o SET
      status=CASE WHEN o.id=r.id THEN 'pending' ELSE 'dead' END,
      payload=$4,link=$5,next_at=r.next_at
    FROM retained r WHERE o.id IN (SELECT id FROM pending) RETURNING o.id`,
    [
      botKey(),
      userId,
      keyPrefix === "run_status" ? ["run_status:%"] : ["turn_progress:%", "turn_final:%"],
      JSON.stringify(payload),
      link ? JSON.stringify(link) : null,
      String(m.message_id),
      m.chat_id,
    ],
  );
  if (!replaced)
    await queue(
      db,
      `${keyPrefix}:${m.message_id}:${opaqueId()}`,
      "editMessageText",
      payload,
      [],
      undefined,
      userId,
      { link },
    );
  await q(
    db,
    "UPDATE telegram_messages SET last_text_hash=$4,edited_at=now() WHERE bot_key=$1 AND chat_id=$2 AND message_id=$3",
    [botKey(), m.chat_id, m.message_id, h],
  );
}

/** Edit only on phase changes, keeping Telegram quiet while work continues in the same phase. */
async function refreshRunningTurn(link: LinkRow, L: string) {
  const active = await chatRepository.activeTurn(link.conversation_id);
  if (!active) return;
  await withTx(async (db) => {
    const m = await statusMessage(db, link, active.id);
    if (!m || (m.edited_at && Date.now() - new Date(m.edited_at).getTime() < TURN_EDIT_MS)) return;
    const current = await chatRepository.activeTurn(link.conversation_id, db);
    if (!current || current.id !== active.id) return;
    const phase = PHASE_LABEL[String(current.phase ?? "")]?.[L === "en" ? 1 : 0];
    if (phase)
      await editTracked(
        db,
        m,
        link.user_id,
        `⏳ ${tr(L, "Đang", "Working")}: ${phase}`,
        "turn_progress",
      );
  });
}

const PROTECTED_LABEL = (tool: string) => !(tool in AUTONOMOUS_ACTIONS);

async function operationButtons(db: Db, link: LinkRow, turnId: number, L: string) {
  const ops = await q<{
    id: number;
    tool: string;
    target: Record<string, unknown>;
    expires_at: string;
    status: string;
    auto: boolean;
    by_policy: boolean;
  }>(
    db,
    // `by_policy`: executed by the owner's chat autonomy policy (a pre-authorized QC/Kafka call is auto too, but not that).
    `SELECT o.id,o.tool,o.target,o.expires_at,o.status,o.auto,
       EXISTS (SELECT 1 FROM chat_autonomy_decisions d WHERE d.operation_id = o.id AND d.allowed) AS by_policy
       FROM chat_operations o WHERE o.turn_id=$1 AND o.owner_id=$2 ORDER BY o.id`,
    [turnId, link.user_id],
  );
  for (const op of ops) {
    const target = textLimit(
      safeTelegramText(
        Object.values(op.target ?? {})
          .filter(Boolean)
          .join(" · "),
      ),
      300,
    );
    if (op.status !== "pending") {
      if (op.auto && op.by_policy)
        await queue(
          db,
          `op_auto:${op.id}`,
          "sendMessage",
          {
            chat_id: link.chat_id,
            text: `🤖 ${tr(L, "Tự động theo policy", "Done by your autonomy policy")}: ${op.tool} — ${target}\n${tr(L, "Kết quả", "Outcome")}: ${op.status}`,
            disable_web_page_preview: true,
          },
          [],
          undefined,
          link.user_id,
          { link: { kind: "notice", conversation_id: link.conversation_id, turn_id: turnId } },
        );
      continue;
    }
    const isProtected = PROTECTED_LABEL(op.tool);
    const summary = `🛠 ${tr(L, "Đề xuất thao tác", "Proposed action")}: ${op.tool}\n${target}${isProtected ? `\n⚠️ ${tr(L, "Thao tác được bảo vệ — cần xác nhận 2 lần.", "Protected action — needs two confirmations.")}` : ""}`;
    const id = opaqueId();
    const inserted = await one(
      db,
      `INSERT INTO telegram_chat_actions(action_id,bot_key,user_id,telegram_user_id,chat_id,kind,conversation_id,turn_id,ref_id,payload,protected,locale,expires_at)
      VALUES($1,$2,$3,$4,$5,'operation',$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING action_id`,
      [
        id,
        botKey(),
        link.user_id,
        link.telegram_user_id,
        link.chat_id,
        link.conversation_id,
        turnId,
        op.id,
        JSON.stringify({ summary, tool: op.tool }),
        isProtected,
        L === "en" ? "en" : "vi",
        op.expires_at,
      ],
    );
    if (!inserted) continue;
    await queue(
      db,
      `op_buttons:${op.id}`,
      "sendMessage",
      {
        chat_id: link.chat_id,
        text: summary,
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [
              { text: tr(L, "✅ Xác nhận", "✅ Confirm"), callback_data: `c:${id}:y` },
              { text: tr(L, "❌ Từ chối", "❌ Reject"), callback_data: `c:${id}:n` },
            ],
          ],
        },
      },
      [],
      undefined,
      link.user_id,
      {
        link: { kind: "operation", conversation_id: link.conversation_id, turn_id: turnId },
        chatActionIds: [id],
      },
    );
  }
}

/**
 * A `work.delegate` proposal of this turn: started at once when the owner's autonomy policy allows it (allowlisted
 * workflow, limits, risk, and the title not derived from untrusted observations), otherwise offered as buttons.
 */
async function delegationProposals(link: LinkRow, turnId: number, L: string) {
  const calls = await q<{ id: number; result: Record<string, unknown> | null }>(
    pool,
    "SELECT id,result FROM chat_tool_calls WHERE turn_id=$1 AND owner_id=$2 AND tool='work.delegate' AND status='ok' ORDER BY seq",
    [turnId, link.user_id],
  );
  const conversation = calls.length
    ? await chatRepository.getConversation(link.conversation_id, link.user_id)
    : null;
  for (const call of calls) {
    const result = call.result ?? {};
    if (result.status !== "awaiting_user_confirmation" || !conversation) continue;
    if (
      await one(
        pool,
        "SELECT 1 FROM telegram_chat_actions WHERE bot_key=$1 AND kind='delegation' AND conversation_id=$2 AND ref_id=$3",
        [botKey(), link.conversation_id, call.id],
      )
    )
      continue;
    const request = result.request as { title?: string; kind?: string; repositories?: string[] };
    let preview: Awaited<ReturnType<typeof buildDelegationPreview>>;
    try {
      preview = await buildDelegationPreview(conversation, request as never);
    } catch (e) {
      await queue(
        pool,
        `deleg_err:${call.id}`,
        "sendMessage",
        {
          chat_id: link.chat_id,
          text: `⚠️ ${tr(L, "Không chuẩn bị được đề xuất giao việc", "Could not prepare the delegation")}: ${textLimit(safeTelegramText((e as Error).message), 200)}`,
        },
        [],
        undefined,
        link.user_id,
      );
      continue;
    }
    const summary = [
      `📦 ${tr(L, "Đề xuất giao việc", "Delegation proposal")}: ${textLimit(safeTelegramText(preview.title), 150)}`,
      `Workflow: ${preview.workflow ? `${preview.workflow.name} (${preview.workflow.key})` : "—"}`,
      `${tr(L, "Repo", "Repos")}: ${preview.repositories.join(", ") || "—"}`,
      `${tr(L, "Rủi ro", "Risk")}: ${preview.risk.level}${preview.risk.reasons.length ? ` — ${textLimit(safeTelegramText(preview.risk.reasons.join("; ")), 200)}` : ""}`,
      ...preview.warnings.slice(0, 3).map((w) => `⚠️ ${textLimit(safeTelegramText(w), 160)}`),
    ].join("\n");
    // Autonomy: only when the title is backed by the owner's own messages (not by logs/documents the chat read).
    let autoStarted = false;
    if (preview.workflow && !preview.warnings.some((w) => /disabled|no workflow/.test(w))) {
      // Unattended start only when EVERY part of the delegation — title, repositories, the description that becomes
      // the run's instructions, the workflow — is the owner's own wording. Anything the model composed or read
      // (logs, tool output, documents) makes it unknown/untrusted → the owner taps.
      const provenance = await operationProvenance(
        { userId: link.user_id, conversationId: link.conversation_id },
        "work.delegate",
        {
          title: preview.title,
          repositories: preview.repositories,
          description: preview.description,
          workflow: preview.workflow.key,
        },
      ).catch(() => null);
      const untrusted = !provenance
        ? "provenance could not be checked"
        : provenance.decision === "deny" || provenance.fields.some((f) => f.origin !== "trusted")
          ? `delegation content not authored by the owner (${provenance.fields
              .filter((f) => f.origin !== "trusted")
              .map((f) => `${f.field}: ${f.origin}`)
              .join(", ")})`
          : undefined;
      {
        const verdict = await decideChatAutonomy({
          ownerId: link.user_id,
          action: "work.delegate",
          workflow: preview.workflow.key,
          repositories: preview.repositories,
          texts: [preview.title, preview.description],
          conversationId: link.conversation_id,
          requireHuman: untrusted,
        });
        if (verdict.allowed) {
          const d = await executeDelegation(conversation, request as never, {
            hash: preview.hash,
            confirmed: true,
          }).catch((e: Error) => ({ run_id: null, run_error: e.message, work_item_code: null }));
          if (d.run_id) await attachAutonomousRun(verdict, d.run_id);
          await withTx(async (db) => {
            await q(
              db,
              `INSERT INTO telegram_chat_actions(action_id,bot_key,user_id,telegram_user_id,chat_id,kind,conversation_id,turn_id,ref_id,payload,locale,status,decided_at)
              VALUES($1,$2,$3,$4,$5,'delegation',$6,$7,$8,$9,$10,'consumed',now()) ON CONFLICT DO NOTHING`,
              [
                opaqueId(),
                botKey(),
                link.user_id,
                link.telegram_user_id,
                link.chat_id,
                link.conversation_id,
                turnId,
                call.id,
                JSON.stringify({ summary, autonomous: verdict.decisionId }),
                L === "en" ? "en" : "vi",
              ],
            );
            await queue(
              db,
              `deleg_auto:${call.id}`,
              "sendMessage",
              {
                chat_id: link.chat_id,
                text: `${summary}\n\n🤖 ${tr(L, `Tự động khởi chạy theo policy ${verdict.mode}`, `Started automatically by your ${verdict.mode} policy`)}${d.run_id ? ` · Run #${d.run_id}\n${runUrl(d.run_id)}` : d.run_error ? `\n⚠️ ${textLimit(safeTelegramText(d.run_error), 200)}` : ""}\n${tr(L, "Dừng khẩn cấp: /stop all", "Emergency stop: /stop all")}`,
                disable_web_page_preview: true,
              },
              [],
              undefined,
              link.user_id,
              {
                link: {
                  kind: "notice",
                  conversation_id: link.conversation_id,
                  turn_id: turnId,
                  run_id: d.run_id,
                },
              },
            );
            if (d.run_id)
              await q(
                db,
                `INSERT INTO telegram_run_watch(user_id,run_id,watched) VALUES($1,$2,true)
                ON CONFLICT(user_id,run_id) DO UPDATE SET watched=true`,
                [link.user_id, d.run_id],
              );
          });
          autoStarted = true;
        }
      }
    }
    if (autoStarted) continue;
    const id = opaqueId();
    await withTx(async (db) => {
      const inserted = await one(
        db,
        `INSERT INTO telegram_chat_actions(action_id,bot_key,user_id,telegram_user_id,chat_id,kind,conversation_id,turn_id,ref_id,payload,locale,expires_at)
        VALUES($1,$2,$3,$4,$5,'delegation',$6,$7,$8,$9,$10,now()+interval '60 minutes') ON CONFLICT DO NOTHING RETURNING action_id`,
        [
          id,
          botKey(),
          link.user_id,
          link.telegram_user_id,
          link.chat_id,
          link.conversation_id,
          turnId,
          call.id,
          JSON.stringify({ summary, request, hash: preview.hash }),
          L === "en" ? "en" : "vi",
        ],
      );
      if (!inserted) return;
      await queue(
        db,
        `deleg_buttons:${call.id}`,
        "sendMessage",
        {
          chat_id: link.chat_id,
          text: summary,
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: preview.workflow
              ? [
                  [
                    { text: tr(L, "▶️ Bắt đầu", "▶️ Start"), callback_data: `c:${id}:y` },
                    { text: tr(L, "Bỏ qua", "Dismiss"), callback_data: `c:${id}:n` },
                  ],
                ]
              : [[{ text: tr(L, "Bỏ qua", "Dismiss"), callback_data: `c:${id}:n` }]],
          },
        },
        [],
        undefined,
        link.user_id,
        {
          link: { kind: "operation", conversation_id: link.conversation_id, turn_id: turnId },
          chatActionIds: [id],
        },
      );
    });
  }
}

/** One finished turn: final status line, the answer in parts, then its operations and proposals. */
/** "deferred": not deliverable yet — the caller stops here so no later turn moves the cursor past it. */
async function deliverTurn(
  link: LinkRow,
  turnId: number,
  L: string,
): Promise<"delivered" | "deferred"> {
  const turn = await chatRepository.getTurn(turnId);
  if (!turn) return "delivered";
  const fromTelegram = String(turn.client_message_id ?? "").startsWith("tg-");
  // Proposals first (idempotent per tool call; preview/policy/delegation use their own connections): a failure leaves
  // the cursor where it is and the whole turn is retried on the next pass — nothing is lost after a crash.
  try {
    await delegationProposals(link, turnId, L);
  } catch (e) {
    log.warn(
      `telegram gateway: delegation proposal of turn ${turnId} (retried): ${(e as Error).message.slice(0, 200)}`,
    );
    return "deferred";
  }
  const finalLine =
    turn.status === "completed"
      ? `✅ ${tr(L, "Xong", "Done")}`
      : turn.status === "canceled"
        ? `⛔ ${tr(L, "Đã dừng", "Stopped")}`
        : `❌ ${tr(L, "Lỗi", "Failed")}: ${preview(safeTelegramText((turn.failure as { message?: string } | null)?.message ?? turn.error ?? "—"), 200)}`;
  const answer = await chatRepository.messageOfTurn(turnId, "assistant");
  const user = fromTelegram ? null : await chatRepository.messageOfTurn(turnId, "user");
  let body = "";
  if (answer?.content) {
    const [visible] = withholdRevoked([answer], await readableRepositories(link.user_id));
    body = telegramAnswer(visible.content);
  }
  const context = user
    ? `💻 ${tr(L, "Từ web", "From the web")}: ${preview(safeTelegramText(user.content), 200)}`
    : "";
  let text = [context, turn.status !== "completed" || !body ? finalLine : "", body]
    .filter(Boolean)
    .join("\n\n");
  let keyboard: { text: string; url: string }[][] | undefined;
  if (text.length > TELEGRAM_TEXT_MAX) {
    const url = conversationUrl(link.conversation_id);
    const label = tr(L, "Xem tiếp trên web", "Continue on the web");
    if (isPublicHttps(url)) {
      keyboard = [[{ text: label, url }]];
      text = preview(text);
    } else {
      const footer = `\n\n${label}: ${url}`;
      text = preview(text, TELEGRAM_TEXT_MAX - footer.length) + footer;
    }
  }
  await withTx(async (db) => {
    const locked = await one<{ delivered_turn_id: string }>(
      db,
      "SELECT delivered_turn_id FROM telegram_chat_links WHERE user_id=$1 AND conversation_id=$2 FOR UPDATE",
      [link.user_id, link.conversation_id],
    );
    if (!locked || Number(locked.delivered_turn_id) >= turnId) return;
    const progress = fromTelegram
      ? await one(
          db,
          `UPDATE telegram_outbox SET status='dead'
           WHERE bot_key=$1 AND dedupe_key=$2 AND status IN ('pending','dead') RETURNING payload`,
          [botKey(), `turn_status:${turnId}`],
        )
      : undefined;
    const status = fromTelegram ? await statusMessage(db, link, turnId) : undefined;
    const answerLink = {
      kind: "answer",
      conversation_id: link.conversation_id,
      turn_id: turnId,
    } as const;
    if (status) {
      await editTracked(db, status, link.user_id, text, "turn_final", keyboard, answerLink);
    } else {
      await queue(
        db,
        `turn_answer:${turnId}:0`,
        "sendMessage",
        {
          chat_id: link.chat_id,
          text,
          disable_web_page_preview: true,
          ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
          ...(progress?.payload.reply_parameters
            ? { reply_parameters: progress.payload.reply_parameters }
            : {}),
        },
        [],
        undefined,
        link.user_id,
        { link: answerLink },
      );
    }
    await operationButtons(db, link, turnId, L);
    await q(db, "UPDATE telegram_chat_links SET delivered_turn_id=$2 WHERE user_id=$1", [
      link.user_id,
      turnId,
    ]);
  });
  return "delivered";
}

export async function syncChatTurns() {
  for (const link of await links()) {
    const L = String((await preferences(link.user_id)).locale);
    try {
      await refreshRunningTurn(link, L);
      const done = await q<{ id: number }>(
        pool,
        `SELECT id FROM chat_turns WHERE conversation_id=$1 AND id>$2 AND status IN ('completed','failed','canceled')
          AND NOT EXISTS (SELECT 1 FROM chat_turns a WHERE a.conversation_id=$1 AND a.id<chat_turns.id AND a.id>$2 AND a.status IN ('queued','running'))
          ORDER BY id LIMIT 5`,
        [link.conversation_id, link.delivered_turn_id],
      );
      for (const t of done) if ((await deliverTurn(link, Number(t.id), L)) === "deferred") break;
    } catch (e) {
      log.warn(
        `telegram gateway: chat sync for user ${link.user_id}: ${(e as Error).message.slice(0, 200)}`,
      );
    }
  }
}

// ---------------------------------------------------------------- runs

interface RunSnapshot {
  status: string;
  step?: { key: string; name: string; status: string } | null;
  failed: string[];
  retrying: string[];
  prs: number[];
  autonomy: number;
}

async function runFacts(runId: number, db: Db = pool) {
  const run = await one<{
    id: number;
    owner_id: number;
    title: string;
    status: string;
    definition_key: string;
    error: string | null;
    updated_at: string;
  }>(
    db,
    "SELECT id,owner_id,title,status,definition_key,error,updated_at FROM workflow_runs WHERE id=$1",
    [runId],
  );
  if (!run) return null;
  const steps = await q<{
    key: string;
    name: string;
    status: string;
    attempt_count: number;
  }>(
    db,
    "SELECT key,name,status,attempt_count FROM workflow_steps WHERE run_id=$1 ORDER BY position",
    [runId],
  );
  const prs = await q<{ id: number; url: string; title: string }>(
    db,
    "SELECT id,url,title FROM pull_requests WHERE run_id=$1 AND created ORDER BY id",
    [runId],
  );
  const autonomy = await one<{ id: string | null; reason: string | null }>(
    db,
    `SELECT max(id) AS id, (array_agg(reason ORDER BY id DESC))[1] AS reason FROM execution_decisions
      WHERE run_id=$1 AND kind='autonomy' AND action='ALLOW' AND outcome='applied'`,
    [runId],
  );
  const current =
    steps.find((s) =>
      ["RUNNING", "RETRYING", "WAITING_INPUT", "WAITING_APPROVAL", "FAILED", "READY"].includes(
        s.status,
      ),
    ) ?? null;
  const snapshot: RunSnapshot = {
    status: run.status,
    step: current ? { key: current.key, name: current.name, status: current.status } : null,
    failed: steps.filter((s) => s.status === "FAILED").map((s) => s.key),
    retrying: steps.filter((s) => s.status === "RETRYING").map((s) => s.key),
    prs: prs.map((p) => Number(p.id)),
    autonomy: Number(autonomy?.id ?? 0),
  };
  return { run, steps, prs, snapshot, autonomyReason: autonomy?.reason ?? null };
}

function blocker(f: NonNullable<Awaited<ReturnType<typeof runFacts>>>, L: string) {
  const { run, snapshot } = f;
  if (snapshot.step?.status === "WAITING_APPROVAL")
    return tr(L, "chờ bạn duyệt", "waiting for your approval");
  if (snapshot.step?.status === "WAITING_INPUT")
    return tr(L, "chờ bạn trả lời", "waiting for your answer");
  if (snapshot.step?.status === "FAILED") return tr(L, "bước thất bại", "a step failed");
  if (run.status === "PAUSED")
    return `${tr(L, "đã tạm dừng", "paused")}${run.error ? ` — ${textLimit(safeTelegramText(run.error), 120)}` : ""}`;
  if (run.status === "WAITING") return tr(L, "đang chờ", "waiting");
  return null;
}

/** The live per-run status message changes when the workflow state changes. */
export async function runStatusText(runId: number, L: string, db: Db = pool) {
  const facts = await runFacts(runId, db);
  return facts
    ? formatRunStatus(facts, L)
    : tr(L, "Run không còn tồn tại.", "The run no longer exists.");
}

function formatRunStatus(f: NonNullable<Awaited<ReturnType<typeof runFacts>>>, L: string) {
  const { run, snapshot } = f;
  const block = RUN_ACTIVE_STATUSES.includes(run.status) ? blocker(f, L) : null;
  return [
    `${STATUS_ICON[run.status] ?? "•"} Run #${run.id} · ${textLimit(safeTelegramText(run.title), 120)}`,
    `Workflow: ${run.definition_key} · ${run.status}`,
    snapshot.step
      ? `${tr(L, "Bước", "Step")}: ${textLimit(safeTelegramText(snapshot.step.name), 80)} (${snapshot.step.status})`
      : "",
    block ? `⛔ ${tr(L, "Vướng", "Blocked")}: ${block}` : "",
    ...f.prs.slice(-2).map((p) => `🔀 PR: ${p.url}`),
    runUrl(run.id),
  ]
    .filter(Boolean)
    .join("\n");
}

const PREF_OF: Record<string, keyof TelegramPreferences> = {
  failure: "failures",
  recovered: "recoveries",
  blocked: "blocked",
  pr: "pull_requests",
  autonomy: "autonomy",
  intake: "intake",
};

/** Buffer a notification (deduplicated by key) when the user's subscriptions and level want it. */
export async function enqueueNotification(
  db: Db,
  userId: number,
  n: { kind: string; severity: Severity; dedupe: string; text: string; runId?: number | null },
  prefs?: TelegramPreferences,
) {
  const p = prefs ?? (await preferences(userId, db));
  const pref = PREF_OF[n.kind];
  if (pref && p[pref] === false) return;
  if (!severityAllowed(String(p.level), n.severity)) return;
  await q(
    db,
    `INSERT INTO telegram_notifications(user_id,kind,severity,run_id,dedupe_key,text) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
    [userId, n.kind, n.severity, n.runId ?? null, n.dedupe, preview(n.text, 800)],
  );
}

function diffEvents(
  f: NonNullable<Awaited<ReturnType<typeof runFacts>>>,
  prev: RunSnapshot,
  L: string,
) {
  const { run, snapshot: now, steps } = f;
  const head = `Run #${run.id} ${textLimit(safeTelegramText(run.title), 80)}`;
  const out: Array<{ kind: string; severity: Severity; dedupe: string; text: string }> = [];
  const stepName = (k: string) =>
    textLimit(safeTelegramText(steps.find((s) => s.key === k)?.name ?? k), 60);
  // The terminal FAILED/COMPLETED notices already exist (notifyTelegramRun): only in-flight changes here.
  if (run.status !== "FAILED")
    for (const k of now.failed.filter((k) => !prev.failed.includes(k))) {
      const s = steps.find((x) => x.key === k);
      out.push({
        kind: "failure",
        severity: "critical",
        dedupe: `step_failed:${run.id}:${k}:${s?.attempt_count ?? 0}`,
        text: `⚠️ ${head}: ${tr(L, "bước", "step")} “${stepName(k)}” ${tr(L, "thất bại", "failed")}${s?.attempt_count ? ` (${tr(L, "lần", "attempt")} ${s.attempt_count})` : ""}. ${tr(L, "Nhắn “giải thích vì sao bước này lỗi” hoặc “thử lại bước này”.", "Ask “explain why this step failed” or “retry this step”.")}`,
      });
    }
  for (const k of new Set([...prev.failed, ...prev.retrying])) {
    if (now.failed.includes(k) || now.retrying.includes(k)) continue;
    const s = steps.find((x) => x.key === k);
    if (s && ["RUNNING", "COMPLETED", "READY"].includes(s.status))
      out.push({
        kind: "recovered",
        severity: "important",
        dedupe: `step_recovered:${run.id}:${k}:${s.attempt_count}`,
        text: `🔄 ${head}: ${tr(L, "bước", "step")} “${stepName(k)}” ${tr(L, "đã phục hồi", "recovered")} (${s.status}).`,
      });
  }
  if (
    now.status !== prev.status &&
    (now.status === "PAUSED" ||
      (now.status === "WAITING" &&
        !["WAITING_INPUT", "WAITING_APPROVAL"].includes(now.step?.status ?? "")))
  )
    out.push({
      kind: "blocked",
      severity: "critical",
      dedupe: `blocked:${run.id}:${now.status}:${run.updated_at}`,
      text: `⛔ ${head}: ${blocker(f, L) ?? now.status}.`,
    });
  for (const p of f.prs.filter((p) => !prev.prs.includes(Number(p.id))))
    out.push({
      kind: "pr",
      severity: "important",
      dedupe: `pr:${p.id}`,
      text: `🔀 ${head}: ${tr(L, "đã tạo PR", "pull request created")} — ${textLimit(safeTelegramText(p.title), 100)}\n${p.url}`,
    });
  if (now.autonomy > prev.autonomy)
    out.push({
      kind: "autonomy",
      severity: "important",
      dedupe: `autonomy:${run.id}:${now.autonomy}`,
      text: `🤖 ${head}: ${tr(L, "nền tảng tự quyết định một cổng theo policy", "the platform decided a gate under the autonomy policy")}${f.autonomyReason ? ` — ${textLimit(safeTelegramText(f.autonomyReason), 160)}` : ""}.`,
    });
  return out;
}

let lastRunSweep = 0;
export async function syncRunWatches(force = false) {
  if (!force && Date.now() - lastRunSweep < RUN_SWEEP_MS) return;
  lastRunSweep = Date.now();
  const rows = await q<{
    id: number;
    owner_id: number;
    chat_id: string;
    state: RunSnapshot | null;
  }>(
    pool,
    `SELECT r.id,r.owner_id,b.chat_id,w.state FROM workflow_runs r
       JOIN telegram_bindings b ON b.user_id=r.owner_id AND b.bot_key=$1 JOIN users u ON u.id=r.owner_id AND u.active
       LEFT JOIN telegram_run_watch w ON w.user_id=r.owner_id AND w.run_id=r.id
      WHERE (r.status = ANY($2) OR r.updated_at > now()-interval '30 minutes' OR w.watched)
        AND NOT EXISTS (SELECT 1 FROM evaluation_runs e WHERE e.workflow_run_id=r.id)
      ORDER BY r.updated_at DESC LIMIT 300`,
    [botKey(), RUN_ACTIVE_STATUSES],
  );
  for (const r of rows) {
    try {
      const f = await runFacts(r.id);
      if (!f) continue;
      const prefs = await preferences(r.owner_id);
      const L = String(prefs.locale);
      const prev = r.state && "status" in r.state ? r.state : null;
      await withTx(async (db) => {
        if (prev)
          for (const n of diffEvents(f, prev, L))
            await enqueueNotification(db, r.owner_id, { ...n, runId: r.id }, prefs);
        const watch = await one<{ watched: boolean }>(
          db,
          `INSERT INTO telegram_run_watch(user_id,run_id,state) VALUES($1,$2,$3)
          ON CONFLICT(user_id,run_id) DO UPDATE SET state=$3,updated_at=now() RETURNING watched`,
          [r.owner_id, r.id, JSON.stringify(f.snapshot)],
        );
        if (!watch?.watched) return;
        const m = await one<{
          chat_id: string;
          message_id: number;
          last_text_hash: string | null;
          edited_at: string | null;
        }>(
          db,
          `SELECT chat_id,message_id,last_text_hash,edited_at FROM telegram_messages
            WHERE bot_key=$1 AND user_id=$2 AND run_id=$3 AND chat_id=$4 AND kind='run_status' ORDER BY created_at DESC LIMIT 1`,
          [botKey(), r.owner_id, r.id, r.chat_id],
        );
        const terminal = !RUN_ACTIVE_STATUSES.includes(f.run.status);
        if (
          !m ||
          (!terminal && m.edited_at && Date.now() - new Date(m.edited_at).getTime() < RUN_EDIT_MS)
        )
          return;
        await editTracked(
          db,
          m,
          r.owner_id,
          formatRunStatus(f, L),
          "run_status",
          terminal
            ? []
            : [[{ text: tr(L, "Bỏ theo dõi", "Unfollow"), callback_data: `u:${r.id}` }]],
        );
        if (terminal)
          await q(
            db,
            "UPDATE telegram_run_watch SET watched=false WHERE user_id=$1 AND run_id=$2",
            [r.owner_id, r.id],
          );
      });
    } catch (e) {
      log.warn(`telegram gateway: run ${r.id} sync: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  await syncIntake();
}

/** Intake items that now need a human (eligible for a manual start, or deferred at high severity). */
async function syncIntake() {
  const items = await q<{
    id: number;
    owner_id: number;
    state: string;
    severity: string | null;
    reason: string;
    revision: string;
    title: string | null;
  }>(
    pool,
    `SELECT i.id,i.owner_id,i.state,i.severity,i.reason,i.revision,w.title FROM intake_items i
       JOIN telegram_bindings b ON b.user_id=i.owner_id AND b.bot_key=$1
       LEFT JOIN work_items w ON w.id=i.work_item_id
      WHERE i.updated_at > now()-interval '15 minutes'
        AND (i.state='eligible' OR (i.state='deferred' AND i.severity IN ('high','critical')))
      ORDER BY i.updated_at DESC LIMIT 100`,
    [botKey()],
  );
  for (const it of items) {
    const prefs = await preferences(it.owner_id);
    const L = String(prefs.locale);
    await enqueueNotification(
      pool,
      it.owner_id,
      {
        kind: "intake",
        severity: it.severity === "critical" || it.severity === "high" ? "critical" : "important",
        dedupe: `intake:${it.id}:${it.state}:${it.revision}`,
        text: `📥 ${tr(L, "Cần chú ý", "Needs attention")}: ${textLimit(safeTelegramText(it.title ?? `#${it.id}`), 100)} · ${it.state}${it.severity ? ` · ${it.severity}` : ""}${it.reason ? ` — ${textLimit(safeTelegramText(it.reason), 120)}` : ""}`,
      },
      prefs,
    );
  }
}

// ---------------------------------------------------------------- notification flush

/**
 * One message per user per window: a single pending notification is sent as is, several become a digest. Non-critical
 * ones wait AGGREGATE_MS for company and are held during quiet hours; critical ones go out (silently when quiet).
 */
export async function flushNotifications(now = new Date()) {
  const users = await q<{ user_id: number; oldest: string; critical: boolean; chat_id: string }>(
    pool,
    `SELECT n.user_id,min(n.created_at) AS oldest,bool_or(n.severity='critical') AS critical,b.chat_id
       FROM telegram_notifications n JOIN telegram_bindings b ON b.user_id=n.user_id AND b.bot_key=$1
      WHERE n.sent_at IS NULL GROUP BY n.user_id,b.chat_id LIMIT 200`,
    [botKey()],
  );
  for (const u of users) {
    const prefs = await preferences(u.user_id);
    const quiet = inQuietHours(prefs, now);
    if (!u.critical && (quiet || now.getTime() - new Date(u.oldest).getTime() < AGGREGATE_MS))
      continue;
    const L = String(prefs.locale);
    await withTx(async (db) => {
      const rows = await q<{ id: number; text: string; run_id: number | null; kind: string }>(
        db,
        `SELECT id,text,run_id,kind FROM telegram_notifications WHERE user_id=$1 AND sent_at IS NULL
          AND ($2::boolean = false OR severity='critical') ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 50`,
        [u.user_id, quiet],
      );
      if (!rows.length) return;
      const visible = rows.slice(0, 10);
      const runId = rows[0].run_id;
      const url = runId != null && rows.every((row) => row.run_id === runId) ? runUrl(runId) : null;
      const label = tr(L, "Xem run", "View run");
      const keyboard =
        url && isPublicHttps(url) ? { inline_keyboard: [[{ text: label, url }]] } : undefined;
      const text = [
        ...(rows.length === 1
          ? [rows[0].text]
          : [
              `🔔 ${rows.length} ${tr(L, "cập nhật", "updates")}`,
              ...visible.map((r) => {
                const [summary, link] = r.text.split("\n");
                return `• ${preview(summary, 200)}${r.kind === "pr" && /^https?:\/\/\S{1,140}$/.test(link ?? "") ? `\n  ${link}` : ""}`;
              }),
              ...(rows.length > visible.length
                ? [
                    `… ${tr(L, "và", "and")} ${rows.length - visible.length} ${tr(L, "cập nhật khác", "more")}`,
                  ]
                : []),
            ]),
        url && !keyboard ? `\n${url}` : "",
        !url && rows.length > 1 ? "\n/runs" : "",
      ]
        .filter(Boolean)
        .join("\n");
      await queue(
        db,
        `notify:${u.user_id}:${rows[rows.length - 1].id}`,
        "sendMessage",
        {
          chat_id: u.chat_id,
          text: preview(text),
          disable_web_page_preview: true,
          ...(keyboard ? { reply_markup: keyboard } : {}),
        },
        [],
        undefined,
        u.user_id,
        { link: { kind: "notice" } },
      );
      await q(db, "UPDATE telegram_notifications SET sent_at=now() WHERE id=ANY($1)", [
        rows.map((r) => r.id),
      ]);
    });
  }
}

/** One receiver-loop pass of the outbound gateway. Failures are logged and retried on the next pass. */
export async function gatewayTick() {
  await syncChatTurns().catch((e) =>
    log.warn(`telegram gateway: ${(e as Error).message.slice(0, 200)}`),
  );
  await syncRunWatches().catch((e) =>
    log.warn(`telegram gateway: ${(e as Error).message.slice(0, 200)}`),
  );
  await flushNotifications().catch((e) =>
    log.warn(`telegram gateway: ${(e as Error).message.slice(0, 200)}`),
  );
}
