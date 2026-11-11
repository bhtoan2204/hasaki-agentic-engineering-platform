import { createHash } from "node:crypto";
import { config } from "../config.ts";
import { pool, q, one, withTx, type Db } from "../db/pool.ts";
import {
  buildStepMessage,
  linkFooter,
  stepLink,
  telegramUrl,
  type StepWaiting,
} from "../telegram.ts";
import { botKey, textLimit, safeTelegramText } from "./client.ts";
import { opaqueId, preferences, queue } from "./store.ts";

export const contextHash = (step: Record<string, any>, question?: Record<string, any> | null) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        step.approval,
        step.config,
        question ? { question: question.question, options: question.options } : null,
      ]),
    )
    .digest("hex");

export type Action = Record<string, any>;
export function navigation(runId: number, key: string, locale: string) {
  return linkFooter(stepLink(runId, key), locale === "en" ? "View run" : "Xem run");
}
export async function makeAction(
  db: Db,
  context: Action,
  type: string,
  value: string | null = null,
) {
  const id = opaqueId();
  await q(
    db,
    `INSERT INTO telegram_actions(action_id,bot_key,user_id,telegram_user_id,chat_id,run_id,step_id,question_id,attempt_id,step_generation,action_type,option_value,locale,message_id,context_hash,requires_confirmation)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      id,
      botKey(),
      context.user_id,
      context.telegram_user_id,
      context.chat_id,
      context.run_id,
      context.step_id,
      context.question_id ?? null,
      context.attempt_id ?? null,
      context.step_generation,
      type,
      value,
      context.locale,
      context.message_id ?? null,
      context.context_hash,
      context.requires_confirmation ?? false,
    ],
  );
  return {
    text:
      type === "approve"
        ? context.locale === "en"
          ? "Approve"
          : "Duyệt"
        : type === "reject"
          ? context.locale === "en"
            ? "Reject"
            : "Từ chối"
          : type === "confirm_approve"
            ? context.locale === "en"
              ? "Confirm approval"
              : "Xác nhận duyệt"
            : type === "confirm_answer"
              ? context.locale === "en"
                ? "Confirm answer"
                : "Xác nhận câu trả lời"
              : type === "cancel"
                ? context.locale === "en"
                  ? "Cancel"
                  : "Hủy"
                : type === "reply"
                  ? context.locale === "en"
                    ? "Reply with answer"
                    : "Trả lời bằng tin nhắn"
                  : textLimit(safeTelegramText(value), 60),
    callback_data: `a:${id}`,
  };
}
export async function sendInteractiveWaiting(w: StepWaiting, dedupeKey: string): Promise<boolean> {
  if (!w.ownerId || config.telegram.mode === "off") return false;
  return withTx(async (db) => {
    const run = await one(db, "SELECT * FROM workflow_runs WHERE id=$1 FOR UPDATE", [w.runId]);
    if (!run || Number(run.owner_id) !== w.ownerId) return false;
    const binding = await one(
      db,
      "SELECT * FROM telegram_bindings WHERE user_id=$1 AND bot_key=$2 FOR UPDATE",
      [w.ownerId, botKey()],
    );
    if (!binding) return false;
    const pref = await preferences(w.ownerId, db);
    if (!(w.status === "WAITING_APPROVAL" ? pref.approvals : pref.questions)) return true;
    const step = await one(db, "SELECT * FROM workflow_steps WHERE run_id=$1 AND key=$2", [
      w.runId,
      w.stepKey,
    ]);
    if (
      !step ||
      step.status !== w.status ||
      ["CANCELED", "COMPLETED", "FAILED"].includes(run.status)
    )
      return true;
    const locale = String(pref.locale),
      en = locale === "en";
    const rows =
      w.status === "WAITING_INPUT"
        ? await q(
            db,
            "SELECT * FROM workflow_questions WHERE step_id=$1 AND attempt_id IS NOT DISTINCT FROM $2 AND status='open' ORDER BY id",
            [step.id, step.current_attempt_id],
          )
        : [null];
    for (const question of rows) {
      const key = `waiting:${dedupeKey}:${question?.id ?? "approval"}`;
      if (
        await one(db, "SELECT id FROM telegram_outbox WHERE bot_key=$1 AND dedupe_key=$2", [
          botKey(),
          key,
        ])
      )
        continue;
      const context = {
        ...binding,
        run_id: run.id,
        step_id: step.id,
        attempt_id: step.current_attempt_id,
        step_generation: step.generation,
        question_id: question?.id,
        locale,
        context_hash: contextHash(step, question),
        requires_confirmation:
          step.config.telegram_confirm === true || step.config.high_impact === true,
      };
      const nav = navigation(run.id, step.key, locale);
      const base = buildStepMessage({
        ...w,
        locale: en ? "en" : "vi",
        runTitle: textLimit(safeTelegramText(run.title), 160),
        stepName: textLimit(safeTelegramText(step.name), 100),
        detail: question
          ? textLimit(safeTelegramText(question.question), 800)
          : textLimit(safeTelegramText(w.detail), 300),
      });
      const keyboard: any[][] = [];
      // Selection/branch forms and fenced provider handoffs require their existing full UI.
      const interactive =
        pref.interactive && config.telegram.mode !== "off" && !step.pending_input?.provider_handoff;
      // An unmet evidence gate needs an explicit risk acknowledgement plus a written reason (engine-enforced), which
      // the full UI collects: no approve button then, but rejecting (with its ForceReply reason) stays available.
      const needsRiskAck = step.approval?.request?.requires_risk_acknowledgement === true;
      if (interactive && !question && !step.config.select_repositories && !step.config.ask_branch) {
        const confirm = step.config.telegram_confirm === true || step.config.high_impact === true;
        keyboard.push([
          ...(needsRiskAck
            ? []
            : [await makeAction(db, context, "approve", confirm ? "confirm" : null)]),
          await makeAction(db, context, "reject"),
        ]);
      } else if (interactive && question) {
        const options = Array.isArray(question.options) ? question.options : [];
        if (
          options.length > 0 &&
          options.length <= 20 &&
          options.every((v: unknown) => typeof v === "string")
        ) {
          for (const value of options)
            keyboard.push([await makeAction(db, context, "answer", value)]);
        } else if (
          !options.length ||
          (options.length > 20 && options.every((v: unknown) => typeof v === "string"))
        ) {
          // Too many options for buttons: a ForceReply answer is still validated against the exact option list.
          keyboard.push([await makeAction(db, context, "reply")]);
        }
      }
      if (nav.reply_markup) keyboard.push(...nav.reply_markup.inline_keyboard);
      const ids = keyboard
        .flat()
        .filter((b) => b.callback_data)
        .map((b) => b.callback_data.slice(2));
      const text =
        base.text +
        `\n${en ? "Provider" : "Nhà cung cấp"}: ${textLimit(run.agent_provider ?? "—", 40)}\n${w.status}`;
      await queue(
        db,
        key,
        "sendMessage",
        {
          ...base,
          text,
          chat_id: binding.chat_id,
          ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
        },
        ids,
        undefined,
        w.ownerId,
      );
    }
    return true;
  });
}
export async function decisionMessage(db: Db, a: Action, label: string) {
  const step = await one(db, "SELECT key,name FROM workflow_steps WHERE id=$1", [a.step_id]);
  const user = await one(db, "SELECT username FROM users WHERE id=$1", [a.user_id]);
  const en = a.locale === "en",
    nav = navigation(a.run_id, step!.key, a.locale);
  const text = `${label}\nRun #${a.run_id} · ${textLimit(safeTelegramText(step!.name), 100)}\n${en ? "By" : "Bởi"}: ${textLimit(user!.username, 80)} (#${a.user_id})\n${new Date().toISOString()}\n${en ? "Decision saved; execution follows the assigned worker." : "Đã lưu quyết định; worker được chỉ định sẽ tiếp tục xử lý."}${nav.text ? `\n${telegramUrl(stepLink(a.run_id, step!.key))}` : ""}`;
  if (a.message_id)
    await queue(
      db,
      `decision:${a.action_id}`,
      "editMessageText",
      {
        chat_id: a.chat_id,
        message_id: a.message_id,
        text,
        reply_markup: nav.reply_markup ?? { inline_keyboard: [] },
      },
      [a.action_id],
    );
}
export async function notifyTelegramRun(runId: number, status: string) {
  if (
    !config.telegram.botToken ||
    config.telegram.mode === "off" ||
    !["COMPLETED", "FAILED"].includes(status)
  )
    return;
  const run = await one(pool, "SELECT * FROM workflow_runs WHERE id=$1", [runId]);
  if (!run?.owner_id) return;
  const binding = await one(
    pool,
    "SELECT * FROM telegram_bindings WHERE user_id=$1 AND bot_key=$2",
    [run.owner_id, botKey()],
  );
  const pref = await preferences(run.owner_id);
  if (!binding || !(status === "FAILED" ? pref.failures : pref.completions)) return;
  const en = pref.locale === "en";
  // No error logs, code or credentials leave the platform in terminal notifications.
  await queue(
    pool,
    `run:${runId}:${status}:${run.updated_at.toISOString()}`,
    "sendMessage",
    {
      chat_id: binding.chat_id,
      text: `${status === "FAILED" ? "❌" : "✅"} Run #${runId} — ${textLimit(safeTelegramText(run.title), 160)}\n${status === "FAILED" ? (en ? "Workflow failed. Open the run for details." : "Workflow thất bại. Mở run để xem chi tiết.") : en ? "Workflow completed." : "Workflow hoàn tất."}
${telegramUrl(stepLink(runId, ""))}`,
      ...(navigation(runId, "", String(pref.locale)).reply_markup
        ? { reply_markup: navigation(runId, "", String(pref.locale)).reply_markup }
        : {}),
    },
    [],
    undefined,
    run.owner_id,
  );
}
