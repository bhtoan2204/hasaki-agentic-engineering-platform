import { config } from "./config.ts";
import { sendTelegramStepWaiting, type StepWaiting } from "./telegram.ts";

/** Fire-and-forget chat notification. Body {text} works for Google Chat and Slack incoming webhooks. */
/** `target` is a UI route ("/runs/12") or, for legacy callers, a task code. */
export async function notify(message: string, target?: string) {
  if (!config.notifyWebhook) return;
  const link = target ? `\n${config.publicUrl}/#${target}` : "";
  try {
    await fetch(config.notifyWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message + link }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error("notify failed:", (e as Error).message);
  }
}

/**
 * A step actually entered WAITING_INPUT / WAITING_APPROVAL (called once per transition, after commit).
 * The webhook keeps its existing message; Telegram gets a message with a deep link to the step. Independent: a failure
 * of one never affects the other or the workflow.
 */
export async function notifyStepWaiting(webhookMessage: string, w: StepWaiting & { stepId: number; generation: number; attemptId?: number | null }) {
  await Promise.allSettled([
    notify(webhookMessage, `/runs/${w.runId}`),
    sendTelegramStepWaiting(w, `${w.stepId}:${w.generation}:${w.attemptId ?? "gate"}:${w.status}`),
  ]);
}
