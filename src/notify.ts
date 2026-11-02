import { config } from "./config.ts";

/** Fire-and-forget chat notification. Body {text} works for Google Chat and Slack incoming webhooks. */
export async function notify(message: string, code?: string) {
  if (!config.notifyWebhook) return;
  const link = code ? `\n${config.publicUrl}/#${code}` : "";
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
