import { redactSecrets } from "../integrations/redact.ts";
/** Redact values before JSON serialization. Regex replacement on encoded JSON can destroy escape sequences. */
export function redactContextText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("["))
    try {
      return JSON.stringify(redactContextValue(JSON.parse(trimmed)));
    } catch {
      /* ordinary source text, not encoded JSON */
    }
  return redactSecrets(text).replace(/\b(?:sk|rt|sess)-[A-Za-z0-9_-]{8,}/g, "[redacted]");
}
export function redactContextValue(value: unknown, depth = 0): any {
  if (depth > 30) return "[bounded nested content]";
  if (typeof value === "string") return redactContextText(value);
  if (Array.isArray(value)) return value.map((v) => redactContextValue(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /^(?:password|passwd|secret|api[_-]?key|(?:access|refresh|auth|session)[_-]?token|client[_-]?secret)$/i.test(k)
          ? "[redacted]"
          : redactContextValue(v, depth + 1),
      ]),
    );
  return value;
}
