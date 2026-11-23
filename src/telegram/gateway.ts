import { pool, q, one, withTx, type Db } from "../db/pool.ts";
import { HttpError } from "../http/error.ts";
import type { Actor } from "../authz/access.ts";
import { chat } from "../chat/service.ts";
import { chatRepository } from "../chat/repository.ts";
import { CHAT_MODES, type ChatMode } from "../chat/types.ts";
import { loadChatHealth } from "../chat/admission.ts";
import { decideOperation } from "../chat/operations.ts";
import { executeDelegation, DelegationRequest } from "../chat/delegation.ts";
import { ownerAutonomySummary, setOwnerAutonomy, type ChatAutonomyMode } from "../chat/autonomy.ts";
import { botKey, safeTelegramText, textLimit } from "./client.ts";
import { limited, preferences, queue, telegramAudit } from "./store.ts";
import { conversationUrl, elapsed, runUrl, STATUS_ICON, tr } from "./format.ts";
import { runStatusText } from "./sync.ts";

/**
 * Telegram as a transport for the existing Chat Runtime. Free text from a bound private chat becomes a chat message of
 * the linked conversation (chat.postMessage: same routing, AUTO mode, tools, permissions and history as the web);
 * slash commands are read-only views or the owner's own settings; buttons resolve through the existing operation and
 * delegation services. Nothing here runs shell commands, decides workflow gates or widens what the owner may do.
 */

export interface GatewayIdentity {
  telegramUser: string;
  chat: string;
  message: {
    message_id?: number;
    text?: string;
    reply_to_message?: { message_id?: number };
    forward_origin?: unknown;
    forward_from?: unknown;
    forward_from_chat?: unknown;
    forward_date?: unknown;
    photo?: unknown;
    document?: unknown;
    voice?: unknown;
  };
}
export interface GatewayActor {
  user_id: number;
  username: string;
  role: string;
}

const actorOf = (a: GatewayActor): Actor => ({
  id: a.user_id,
  username: a.username,
  role: a.role as Actor["role"],
  active: true,
});

/** Callback data owned by the gateway (the workflow approval buttons keep `a:`). */
export const GATEWAY_CALLBACK = /^(?:c:[A-Za-z0-9_-]{24}:[ynY]|[wu]:\d{1,15})$/;

function reply(
  db: Db,
  key: string,
  identity: GatewayIdentity,
  userId: number,
  text: string,
  extra = {},
) {
  return queue(
    db,
    key,
    "sendMessage",
    {
      chat_id: identity.chat,
      text: textLimit(text, 3900),
      disable_web_page_preview: true,
      ...(identity.message.message_id
        ? {
            reply_parameters: {
              message_id: identity.message.message_id,
              allow_sending_without_reply: true,
            },
          }
        : {}),
      ...extra,
    },
    [],
    undefined,
    userId,
    { link: { kind: "notice" } },
  );
}

// ---------------------------------------------------------------- conversation link

async function maxTurnId(conversationId: number, db: Db = pool) {
  const r = await one<{ id: string | null }>(
    db,
    "SELECT max(id) AS id FROM chat_turns WHERE conversation_id=$1",
    [conversationId],
  );
  return Number(r?.id ?? 0);
}

/** Point the user's Telegram chat at a conversation; history before now is not re-sent. */
export async function linkConversation(userId: number, conversationId: number, db: Db = pool) {
  await q(
    db,
    `INSERT INTO telegram_chat_links(user_id,bot_key,conversation_id,delivered_turn_id) VALUES($1,$2,$3,$4)
    ON CONFLICT(user_id) DO UPDATE SET bot_key=$2,conversation_id=$3,delivered_turn_id=$4,updated_at=now()`,
    [userId, botKey(), conversationId, await maxTurnId(conversationId, db)],
  );
}

async function currentLink(userId: number) {
  const link = await one<{ conversation_id: number | null }>(
    pool,
    "SELECT conversation_id FROM telegram_chat_links WHERE user_id=$1 AND bot_key=$2",
    [userId, botKey()],
  );
  if (!link?.conversation_id) return null;
  const c = await chatRepository.getConversation(link.conversation_id, userId);
  return c && !c.archived ? c : null;
}

async function newConversation(actor: Actor, title = "") {
  const c = await chat.create(actor, {
    mode: "AUTO",
    provider: "auto",
    ...(title ? { title: textLimit(title, 200) } : {}),
    description: "Telegram",
  });
  await linkConversation(actor.id, c.id);
  return c;
}

/** A reply to one of the bot's messages continues that message's conversation (and makes it the linked one). */
async function conversationFor(actor: Actor, identity: GatewayIdentity) {
  const replyTo = identity.message.reply_to_message?.message_id;
  if (replyTo) {
    const m = await one<{ conversation_id: number | null }>(
      pool,
      "SELECT conversation_id FROM telegram_messages WHERE bot_key=$1 AND chat_id=$2 AND message_id=$3 AND user_id=$4",
      [botKey(), identity.chat, replyTo, actor.id],
    );
    if (m?.conversation_id) {
      const c = await chatRepository.getConversation(m.conversation_id, actor.id);
      if (c && !c.archived) {
        const linked = await currentLink(actor.id);
        if (linked?.id !== c.id) await linkConversation(actor.id, c.id);
        return c.id;
      }
    }
  }
  return (await currentLink(actor.id))?.id ?? (await newConversation(actor)).id;
}

// ---------------------------------------------------------------- free text → Chat Runtime

export async function handleChatMessage(
  identity: GatewayIdentity,
  actor: GatewayActor,
  updateId: number,
) {
  const userId = actor.user_id;
  const prefs = await preferences(userId);
  const L = String(prefs.locale);
  const m = identity.message;
  // Forwarded text was written by someone else: it is untrusted data, never the owner's instruction (ADR 0010).
  if (m.forward_origin || m.forward_from || m.forward_from_chat || m.forward_date)
    return reply(
      pool,
      `gw_forward:${updateId}`,
      identity,
      userId,
      tr(
        L,
        "Tin nhắn chuyển tiếp không được dùng làm lệnh. Hãy tự gõ yêu cầu, hoặc dán nội dung vào chat trên web dưới dạng tài liệu.",
        "Forwarded messages are not accepted as instructions. Type your request yourself, or attach the content as a document in the web chat.",
      ),
    );
  const text = String(m.text ?? "").trim();
  if (!text)
    return reply(
      pool,
      `gw_nontext:${updateId}`,
      identity,
      userId,
      tr(
        L,
        "Telegram chỉ nhận tin nhắn văn bản. Ảnh/tệp hãy gửi qua chat trên web.",
        "Telegram accepts text only. Send images/files through the web chat.",
      ),
    );
  if (!prefs.chat)
    return reply(
      pool,
      `gw_off:${updateId}`,
      identity,
      userId,
      tr(
        L,
        "Chat qua Telegram đang tắt (Integrations → Telegram). /help để xem lệnh.",
        "Telegram chat is turned off (Integrations → Telegram). /help for commands.",
      ),
    );
  // Agent turns cost money: a tighter per-user budget than the 30/min update limit.
  if (!(await limited(`chat:${identity.telegramUser}`, pool, botKey(), 6)))
    return reply(
      pool,
      `gw_rate:${updateId}`,
      identity,
      userId,
      tr(L, "Bạn gửi quá nhanh, thử lại sau ít phút.", "Too many messages; try again in a minute."),
    );
  const a = actorOf(actor);
  const conversationId = await conversationFor(a, identity);
  // The update id makes Telegram redelivery and inbox retries idempotent (chat_turns UNIQUE client_message_id).
  const clientMessageId = `tg-${botKey().slice(0, 8)}-${updateId}`;
  let posted: Awaited<ReturnType<typeof chat.postMessage>>;
  try {
    posted = await chat.postMessage(a, conversationId, {
      content: textLimit(text, 4000),
      client_message_id: clientMessageId,
    });
  } catch (e) {
    if (e instanceof HttpError && e.status === 409)
      return reply(
        pool,
        `gw_busy:${updateId}`,
        identity,
        userId,
        tr(
          L,
          "⏳ Đang trả lời tin nhắn trước. Đợi xong, hoặc /stop để dừng.",
          "⏳ Still answering your previous message. Wait, or /stop to cancel it.",
        ),
      );
    if (e instanceof HttpError && e.status < 500)
      return reply(
        pool,
        `gw_err:${updateId}`,
        identity,
        userId,
        `⚠️ ${textLimit(safeTelegramText(e.message), 300)}`,
      );
    throw e;
  }
  await queue(
    pool,
    `turn_status:${posted.turn.id}`,
    "sendMessage",
    {
      chat_id: identity.chat,
      text: tr(L, "⏳ Đang xử lý…", "⏳ Working on it…"),
      ...(m.message_id
        ? { reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true } }
        : {}),
    },
    [],
    undefined,
    userId,
    { link: { kind: "turn_status", conversation_id: conversationId, turn_id: posted.turn.id } },
  );
  await telegramAudit(pool, userId, "chat.message", String(conversationId), {
    turnId: posted.turn.id,
    replayed: posted.replayed,
  });
}

// ---------------------------------------------------------------- commands

const COMMAND = /^\/([a-z]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/;
export const GATEWAY_COMMANDS = [
  "help",
  "start",
  "new",
  "link",
  "status",
  "tasks",
  "runs",
  "mode",
  "stop",
];
export function parseCommand(text: string) {
  const m = COMMAND.exec(text.trim());
  if (!m || !GATEWAY_COMMANDS.includes(m[1])) return null;
  return { name: m[1], args: (m[2] ?? "").trim() };
}

function helpText(L: string) {
  return tr(
    L,
    [
      "🤖 Trợ lý nền tảng qua Telegram",
      "",
      "Nhắn tin bình thường để hỏi, điều tra lỗi, tra cứu task/run hoặc giao việc — ví dụ:",
      "• REQ-126 đang làm gì?",
      "• Liệt kê các workflow đang bị chặn",
      "• Điều tra lỗi refund payment",
      "• Tạo task sửa lỗi này",
      "",
      "Lệnh:",
      "/new [tiêu đề] — cuộc trò chuyện mới",
      "/link <id> — nối với cuộc trò chuyện trên web",
      "/status — trạng thái tài khoản, chat, chế độ tự động",
      "/tasks — work item của bạn",
      "/runs [blocked|active|failed] — workflow run",
      "/mode [manual|semi|auto|pause|resume] — chế độ tự động; /mode chat <AUTO|ASK|INVESTIGATE|PLAN|DELEGATE>",
      "/stop — dừng câu trả lời đang chạy; /stop all — dừng khẩn cấp mọi hành động tự động",
      "/cancel — hủy lời nhắc đang chờ trả lời",
      "",
      "Thao tác thay đổi dữ liệu luôn cần bạn xác nhận (hoặc policy tự động bạn đã bật). Không có lệnh shell.",
    ].join("\n"),
    [
      "🤖 Platform assistant on Telegram",
      "",
      "Just write to ask questions, investigate issues, look up tasks/runs or delegate work — e.g.:",
      "• What is REQ-126 doing?",
      "• Show my blocked workflows",
      "• Investigate payment refund errors",
      "• Create a task to fix this bug",
      "",
      "Commands:",
      "/new [title] — new conversation",
      "/link <id> — attach to a web conversation",
      "/status — account, chat and autonomy status",
      "/tasks — your work items",
      "/runs [blocked|active|failed] — workflow runs",
      "/mode [manual|semi|auto|pause|resume] — autonomy; /mode chat <AUTO|ASK|INVESTIGATE|PLAN|DELEGATE>",
      "/stop — stop the running answer; /stop all — emergency stop of autonomous actions",
      "/cancel — cancel a pending reply prompt",
      "",
      "Changes always need your confirmation (or an autonomy policy you enabled). No shell commands.",
    ].join("\n"),
  );
}

async function statusText(actor: Actor, L: string) {
  const c = await currentLink(actor.id);
  const active = c ? await chatRepository.activeTurn(c.id) : null;
  const autonomy = await ownerAutonomySummary(actor.id);
  const runs = await one<{ active: number; waiting: number; paused: number }>(
    pool,
    `SELECT count(*) FILTER (WHERE status IN ('RUNNING','WAITING'))::int AS active,
       (SELECT count(*)::int FROM workflow_steps s JOIN workflow_runs r ON r.id=s.run_id
         WHERE r.owner_id=$1 AND s.status IN ('WAITING_INPUT','WAITING_APPROVAL') AND NOT COALESCE(s.pending_input ? 'child_workflows', false)
           AND r.status NOT IN ('COMPLETED','FAILED','CANCELED')) AS waiting,
       count(*) FILTER (WHERE status='PAUSED')::int AS paused
     FROM workflow_runs WHERE owner_id=$1`,
    [actor.id],
  );
  const health = await loadChatHealth().catch(() => []);
  const providers = health.length
    ? health
        .map((h) => `${h.provider}${h.connected ? (h.quota === "exhausted" ? " ⚠️" : " ✓") : " ✗"}`)
        .join(", ")
    : "—";
  const eff = autonomy.effective;
  return [
    `👤 ${actor.username}`,
    c
      ? `💬 ${tr(L, "Cuộc trò chuyện", "Conversation")} #${c.id}: ${textLimit(safeTelegramText(c.title || "—"), 80)} · ${c.mode} · ${c.provider_strategy === "auto" ? "AUTO" : (c.provider ?? "—")}`
      : `💬 ${tr(L, "Chưa có cuộc trò chuyện (nhắn tin để bắt đầu)", "No conversation yet (send a message to start)")}`,
    active
      ? `⏳ ${tr(L, "Đang trả lời", "Answering")}: ${active.phase ?? active.status} · ${elapsed(active.started_at ?? active.created_at)}`
      : "",
    `🤖 ${tr(L, "Tự động", "Autonomy")}: ${eff.paused ? tr(L, "TẠM DỪNG KHẨN CẤP", "EMERGENCY STOPPED") : eff.mode}${eff.mode !== "MANUAL" ? ` (${eff.actions.join(", ") || "—"})` : ""}`,
    `▶️ Runs: ${runs?.active ?? 0} ${tr(L, "đang chạy", "active")} · ${runs?.waiting ?? 0} ${tr(L, "chờ bạn", "waiting for you")} · ${runs?.paused ?? 0} ${tr(L, "tạm dừng", "paused")}`,
    `🔌 Providers: ${providers}`,
    c ? `🔗 ${conversationUrl(c.id)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function tasksText(actor: Actor, L: string) {
  const items = await chatRepository.listWorkItems(actor.id, { tz: "UTC", limit: 10 });
  if (!items.length) return tr(L, "Bạn chưa có work item nào.", "You have no work items.");
  return [
    `📋 ${tr(L, "Work item gần đây", "Recent work items")}`,
    ...items.map((w) => `• ${w.code} · ${w.status} — ${textLimit(safeTelegramText(w.title), 80)}`),
    "",
    tr(L, "Hỏi “REQ-… đang làm gì?” để xem chi tiết.", "Ask “what is REQ-… doing?” for details."),
  ].join("\n");
}

async function runsView(actor: Actor, L: string, filter: string) {
  const where =
    filter === "blocked"
      ? // WAITING only because of child workflows (a held step or a parallel join) is not blocked on the user.
        `AND (r.status = 'PAUSED' OR EXISTS (SELECT 1 FROM workflow_steps s WHERE s.run_id=r.id AND s.status IN ('WAITING_INPUT','WAITING_APPROVAL','FAILED')
              AND NOT COALESCE(s.pending_input ? 'child_workflows', false)))
         AND r.status NOT IN ('COMPLETED','FAILED','CANCELED')`
      : filter === "failed"
        ? "AND r.status='FAILED'"
        : filter === "active"
          ? "AND r.status IN ('PENDING','RUNNING','WAITING','PAUSED')"
          : "";
  const rows = await q<{
    id: number;
    title: string;
    status: string;
    definition_key: string;
    step: string | null;
    step_status: string | null;
  }>(
    pool,
    `SELECT r.id, r.title, r.status, r.definition_key, s.name AS step, s.status AS step_status
       FROM workflow_runs r
       LEFT JOIN LATERAL (SELECT name, status FROM workflow_steps WHERE run_id=r.id AND status NOT IN ('PENDING','COMPLETED','SKIPPED')
                          ORDER BY position LIMIT 1) s ON true
      WHERE r.owner_id=$1 ${where} AND NOT EXISTS (SELECT 1 FROM evaluation_runs e WHERE e.workflow_run_id=r.id)
      ORDER BY r.id DESC LIMIT 10`,
    [actor.id],
  );
  if (!rows.length)
    return {
      text: tr(L, "Không có run nào khớp.", "No matching runs."),
      keyboard: [] as { text: string; callback_data: string }[][],
    };
  const title =
    filter === "blocked"
      ? tr(L, "Run đang bị chặn / chờ bạn", "Blocked / waiting runs")
      : filter === "failed"
        ? tr(L, "Run thất bại", "Failed runs")
        : filter === "active"
          ? tr(L, "Run đang hoạt động", "Active runs")
          : tr(L, "Run gần đây", "Recent runs");
  return {
    text: [
      `${STATUS_ICON.RUNNING} ${title}`,
      ...rows.map(
        (r) =>
          `${STATUS_ICON[r.status] ?? "•"} #${r.id} ${textLimit(safeTelegramText(r.title), 60)} · ${r.definition_key}${r.step ? ` · ${textLimit(safeTelegramText(r.step), 40)} (${r.step_status})` : ""}`,
      ),
      "",
      tr(L, "Bấm 👁 để theo dõi trạng thái trực tiếp.", "Tap 👁 to follow a run live."),
    ].join("\n"),
    keyboard: rows
      .slice(0, 8)
      .map((r) => ({ text: `👁 #${r.id}`, callback_data: `w:${r.id}` }))
      .reduce<{ text: string; callback_data: string }[][]>((acc, b, i) => {
        if (i % 4 === 0) acc.push([]);
        acc[acc.length - 1].push(b);
        return acc;
      }, []),
  };
}

const MODE_WORDS: Record<string, ChatAutonomyMode> = {
  manual: "MANUAL",
  semi: "SEMI",
  "semi-auto": "SEMI",
  auto: "AUTONOMOUS",
  autonomous: "AUTONOMOUS",
};

async function modeCommand(actor: Actor, L: string, args: string) {
  const [first, second] = args.split(/\s+/);
  const word = (first ?? "").toLowerCase();
  if (word === "chat") {
    const mode = (second ?? "").toUpperCase();
    if (!(CHAT_MODES as readonly string[]).includes(mode))
      return tr(L, `Chế độ chat: ${CHAT_MODES.join(", ")}`, `Chat modes: ${CHAT_MODES.join(", ")}`);
    const c = (await currentLink(actor.id)) ?? (await newConversation(actor));
    await chat.update(actor, c.id, { mode: mode as ChatMode });
    return tr(L, `💬 Chế độ chat: ${mode}`, `💬 Chat mode: ${mode}`);
  }
  if (word in MODE_WORDS) await setOwnerAutonomy(actor, { mode: MODE_WORDS[word] });
  else if (word === "pause") await setOwnerAutonomy(actor, { paused: true });
  else if (word === "resume") await setOwnerAutonomy(actor, { paused: false });
  else if (word)
    return tr(
      L,
      "Dùng: /mode manual|semi|auto|pause|resume",
      "Use: /mode manual|semi|auto|pause|resume",
    );
  const s = await ownerAutonomySummary(actor.id);
  const own = s.own;
  const c = await currentLink(actor.id);
  return [
    `🤖 ${tr(L, "Chế độ tự động của bạn", "Your autonomy mode")}: ${own ? own.mode : "MANUAL"}${own?.paused ? ` (${tr(L, "tạm dừng", "paused")})` : ""}`,
    `${tr(L, "Hiệu lực", "Effective")}: ${s.effective.paused ? tr(L, "DỪNG KHẨN CẤP", "EMERGENCY STOP") : s.effective.mode}`,
    `${tr(L, "Trần quản trị", "Admin ceiling")}: ${s.global ? `${s.global.mode}${s.global.paused ? " (paused)" : ""}` : tr(L, "chưa cấu hình (luôn thủ công)", "not configured (always manual)")}`,
    `${tr(L, "Hành động được phép", "Allowed actions")}: ${s.effective.actions.join(", ") || "—"}`,
    `Workflows: ${s.effective.workflows?.join(", ") || "—"}`,
    ...s.effective.reasons.slice(0, 3).map((r) => `• ${r}`),
    c ? `💬 ${tr(L, "Chế độ chat", "Chat mode")}: ${c.mode}` : "",
    "",
    tr(
      L,
      "MANUAL: mọi thao tác cần bạn xác nhận. SEMI: tự làm việc rủi ro thấp (tạm dừng/tiếp tục). AUTO: thêm việc rủi ro vừa trong danh sách cho phép. Duyệt bước, merge PR, deploy, dữ liệu production và secret không bao giờ tự động.",
      "MANUAL: you confirm every action. SEMI: low-risk actions (pause/resume) run automatically. AUTO: also allowlisted medium-risk ones. Step approvals, PR merges, deploys, production data and secrets are never automatic.",
    ),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

async function stopCommand(actor: Actor, L: string, args: string) {
  const lines: string[] = [];
  const c = await currentLink(actor.id);
  const active = c ? await chatRepository.activeTurn(c.id) : null;
  if (active) {
    await chat.cancelTurn(actor, active.id);
    lines.push(tr(L, "⛔ Đã dừng câu trả lời đang chạy.", "⛔ Stopped the running answer."));
  }
  if (args.toLowerCase() === "all") {
    await setOwnerAutonomy(actor, { paused: true });
    const { pauseRun } = await import("../workflow/engine.ts");
    const runs = await q<{ run_id: number }>(
      pool,
      `SELECT DISTINCT d.run_id FROM chat_autonomy_decisions d JOIN workflow_runs r ON r.id=d.run_id
        WHERE d.owner_id=$1 AND d.allowed AND r.status IN ('RUNNING','WAITING')`,
      [actor.id],
    );
    let paused = 0;
    for (const r of runs)
      try {
        await pauseRun(r.run_id);
        paused++;
      } catch {
        /* already finished or not pausable: reported by the count */
      }
    await telegramAudit(pool, actor.id, "autonomy.emergency_stop", String(actor.id), {
      pausedRuns: paused,
    });
    lines.push(
      tr(
        L,
        `🛑 Dừng khẩn cấp: tắt tự động, tạm dừng ${paused} run do tự động khởi chạy. /mode resume để bật lại.`,
        `🛑 Emergency stop: autonomy paused, ${paused} autonomously started run(s) paused. /mode resume to re-enable.`,
      ),
    );
  }
  return lines.join("\n") || tr(L, "Không có gì đang chạy.", "Nothing is running.");
}

export async function handleCommand(
  identity: GatewayIdentity,
  actor: GatewayActor,
  updateId: number,
  cmd: { name: string; args: string },
) {
  const a = actorOf(actor);
  const L = String((await preferences(a.id)).locale);
  let text = "";
  let extra: Record<string, unknown> = {};
  switch (cmd.name) {
    case "help":
    case "start":
      text = helpText(L);
      break;
    case "new": {
      const c = await newConversation(a, cmd.args);
      text = tr(
        L,
        `🆕 Cuộc trò chuyện mới #${c.id}. Hãy nhắn yêu cầu của bạn.`,
        `🆕 New conversation #${c.id}. Send your request.`,
      );
      break;
    }
    case "link": {
      const id = Number(cmd.args);
      const c =
        Number.isSafeInteger(id) && id > 0 ? await chatRepository.getConversation(id, a.id) : null;
      if (!c)
        text = tr(
          L,
          "Không tìm thấy cuộc trò chuyện của bạn. Dùng: /link <id>",
          "Conversation not found. Use: /link <id>",
        );
      else {
        await linkConversation(a.id, c.id);
        text = tr(
          L,
          `🔗 Đã nối với #${c.id} “${textLimit(safeTelegramText(c.title), 80)}”. Câu trả lời mới (cả từ web) sẽ hiện ở đây.\n${conversationUrl(c.id)}`,
          `🔗 Linked to #${c.id} “${textLimit(safeTelegramText(c.title), 80)}”. New answers (also from the web) will appear here.\n${conversationUrl(c.id)}`,
        );
      }
      break;
    }
    case "status":
      text = await statusText(a, L);
      break;
    case "tasks":
      text = await tasksText(a, L);
      break;
    case "runs": {
      const v = await runsView(a, L, cmd.args.toLowerCase());
      text = v.text;
      if (v.keyboard.length) extra = { reply_markup: { inline_keyboard: v.keyboard } };
      break;
    }
    case "mode":
      text = await modeCommand(a, L, cmd.args);
      break;
    case "stop":
      text = await stopCommand(a, L, cmd.args);
      break;
  }
  await telegramAudit(pool, a.id, `command.${cmd.name}`, String(updateId));
  await reply(pool, `gw_cmd:${updateId}`, identity, a.id, text, extra);
}

// ---------------------------------------------------------------- buttons

/** Follow a run: one status message, edited in place while the run moves (sync.ts). */
export async function watchRun(db: Db, userId: number, chatId: string, runId: number, key: string) {
  const run = await one<{ id: number }>(
    db,
    "SELECT id FROM workflow_runs WHERE id=$1 AND owner_id=$2",
    [runId, userId],
  );
  if (!run) throw new HttpError(403, "run not found");
  await q(
    db,
    `INSERT INTO telegram_run_watch(user_id,run_id,watched) VALUES($1,$2,true)
    ON CONFLICT(user_id,run_id) DO UPDATE SET watched=true,updated_at=now()`,
    [userId, runId],
  );
  const L = String((await preferences(userId, db)).locale);
  await queue(
    db,
    `run_watch:${userId}:${runId}:${key}`,
    "sendMessage",
    {
      chat_id: chatId,
      text: await runStatusText(runId, L, db),
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [{ text: tr(L, "Bỏ theo dõi", "Unfollow"), callback_data: `u:${runId}` }],
        ],
      },
    },
    [],
    undefined,
    userId,
    { link: { kind: "run_status", run_id: runId } },
  );
}

interface ChatActionRow {
  action_id: string;
  bot_key: string;
  user_id: number;
  telegram_user_id: string;
  chat_id: string;
  kind: "operation" | "delegation";
  conversation_id: number;
  ref_id: number | null;
  payload: Record<string, unknown>;
  protected: boolean;
  status: string;
  locale: string;
  message_id: number | null;
  fresh: boolean;
}

function editAction(
  db: Db,
  a: ChatActionRow,
  key: string,
  text: string,
  keyboard: unknown[][] = [],
) {
  if (!a.message_id) return Promise.resolve();
  return queue(
    db,
    `chat_action:${a.action_id}:${key}`,
    "editMessageText",
    {
      chat_id: a.chat_id,
      message_id: a.message_id,
      text: textLimit(text, 3900),
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard },
    },
    [],
    undefined,
    a.user_id,
  );
}

/** Returns the callback answer text. Ownership, chat, message, expiry and status are checked before anything runs. */
export async function handleGatewayCallback(
  identity: GatewayIdentity,
  actor: GatewayActor,
  data: string,
  callbackMessageId: number | undefined,
): Promise<string> {
  const userId = actor.user_id;
  const L = String((await preferences(userId)).locale);
  if (data.startsWith("w:") || data.startsWith("u:")) {
    const runId = Number(data.slice(2));
    if (data.startsWith("u:")) {
      await q(pool, "UPDATE telegram_run_watch SET watched=false WHERE user_id=$1 AND run_id=$2", [
        userId,
        runId,
      ]);
      return tr(L, "Đã bỏ theo dõi", "Unfollowed");
    }
    await withTx((db) =>
      watchRun(db, userId, identity.chat, runId, String(callbackMessageId ?? 0)),
    );
    return tr(L, "Đang theo dõi run", "Following the run");
  }
  const [, id, choice] = data.split(":");
  const a = await one<ChatActionRow>(
    pool,
    "SELECT *,expires_at>now() AS fresh FROM telegram_chat_actions WHERE action_id=$1",
    [id],
  );
  if (
    !a ||
    a.bot_key !== botKey() ||
    a.user_id !== userId ||
    a.chat_id !== identity.chat ||
    a.telegram_user_id !== identity.telegramUser ||
    (a.message_id != null && Number(a.message_id) !== callbackMessageId)
  )
    throw new HttpError(403, "denied");
  if (a.status === "consumed" || a.status === "canceled")
    return tr(L, "Đã xử lý trước đó", "Already processed");
  if (!a.fresh || a.status === "expired") {
    await q(
      pool,
      "UPDATE telegram_chat_actions SET status='expired' WHERE action_id=$1 AND status IN ('pending','armed')",
      [id],
    );
    await editAction(
      pool,
      a,
      "expired",
      tr(
        L,
        "⌛ Đã hết hạn. Hỏi lại trong chat để tạo đề xuất mới.",
        "⌛ Expired. Ask again in the chat for a fresh proposal.",
      ),
    );
    return tr(L, "Đã hết hạn", "Expired");
  }
  const summary = String(a.payload.summary ?? "");
  if (choice === "n") {
    if (a.kind === "operation" && a.ref_id)
      await decideOperation({ id: userId }, Number(a.ref_id), "reject");
    await q(
      pool,
      "UPDATE telegram_chat_actions SET status='canceled',decided_at=now() WHERE action_id=$1",
      [id],
    );
    await telegramAudit(pool, userId, "chat_action.rejected", id, { kind: a.kind, ref: a.ref_id });
    await editAction(
      pool,
      a,
      "rejected",
      `${summary}\n\n❌ ${tr(L, "Đã từ chối — không có gì được thực hiện.", "Rejected — nothing was executed.")}`,
    );
    return tr(L, "Đã từ chối", "Rejected");
  }
  // Protected actions (step approvals, external writes) need a second, explicit tap.
  if (a.protected && choice === "y") {
    const armed = await one(
      pool,
      "UPDATE telegram_chat_actions SET status='armed' WHERE action_id=$1 AND status='pending' RETURNING action_id",
      [id],
    );
    if (armed)
      await editAction(
        pool,
        a,
        "armed",
        `${summary}\n\n⚠️ ${tr(L, "Thao tác được bảo vệ. Bấm lần nữa để xác nhận.", "Protected action. Tap again to confirm.")}`,
        [
          [
            { text: tr(L, "⚠️ Xác nhận lần 2", "⚠️ Confirm again"), callback_data: `c:${id}:Y` },
            { text: tr(L, "Hủy", "Cancel"), callback_data: `c:${id}:n` },
          ],
        ],
      );
    return tr(L, "Bấm lần nữa để xác nhận", "Tap again to confirm");
  }
  if (a.protected && a.status !== "armed") throw new HttpError(409, "confirmation required");
  // The services below are idempotent (operation status claim, delegation preview hash): a replay after a crash
  // returns the earlier outcome instead of running twice. The action is closed only after they answered.
  let outcome: string;
  let runId: number | null = null;
  if (a.kind === "operation") {
    const op = await decideOperation({ id: userId }, Number(a.ref_id), "confirm");
    outcome =
      op.status === "succeeded"
        ? tr(L, "✅ Đã thực hiện.", "✅ Done.")
        : op.status === "expired"
          ? tr(L, "⌛ Đề xuất đã hết hạn.", "⌛ The proposal expired.")
          : `⚠️ ${op.status}${op.error ? `: ${textLimit(safeTelegramText(op.error), 200)}` : ""}`;
    if (op.status === "succeeded" && op.tool === "runs.start")
      runId = Number(op.arguments.run_id) || null;
  } else {
    const conversation = await chatRepository.getConversation(a.conversation_id, userId);
    if (!conversation) throw new HttpError(404, "conversation not found");
    const request = DelegationRequest.parse(a.payload.request);
    try {
      const d = await executeDelegation(conversation, request, {
        hash: String(a.payload.hash),
        confirmed: true,
      });
      runId = d.run_id ?? null;
      outcome = d.run_error
        ? `⚠️ ${tr(L, "Đã tạo work item nhưng chưa chạy được", "Work item created but the run did not start")}: ${textLimit(safeTelegramText(d.run_error), 200)}`
        : `▶️ ${tr(L, "Đã bắt đầu", "Started")} ${d.work_item_code ?? ""}${runId ? ` · Run #${runId}` : ""}${d.duplicate ? tr(L, " (đã có từ trước)", " (already started)") : ""}`;
    } catch (e) {
      if (!(e instanceof HttpError) || e.status >= 500) throw e;
      outcome = `⚠️ ${textLimit(safeTelegramText(e.message), 300)}`;
    }
  }
  await withTx(async (db) => {
    await q(
      db,
      "UPDATE telegram_chat_actions SET status='consumed',decided_at=now(),result=$2 WHERE action_id=$1 AND status IN ('pending','armed')",
      [id, JSON.stringify({ outcome, runId })],
    );
    await telegramAudit(db, userId, "chat_action.confirmed", id, {
      kind: a.kind,
      ref: a.ref_id,
      runId,
    });
    await editAction(db, a, "done", `${summary}\n\n${outcome}${runId ? `\n${runUrl(runId)}` : ""}`);
    if (runId) await watchRun(db, userId, a.chat_id, runId, `action:${id}`);
  });
  return outcome.slice(0, 180);
}
