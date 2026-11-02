import { config } from "./config.ts";

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
    });
  } catch (e) {
    console.error("notify failed:", (e as Error).message);
  }
}
