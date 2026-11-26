import { redactPii } from "../integrations/redact.ts";
import { looksSecret, redactSecretMatches } from "../knowledge/importer.ts";
import type { SharedKind } from "./types.ts";

/**
 * Scrub policy of a shared snapshot (docs/shared-results/PLAN.md, section 6.3), applied BEFORE anything is stored:
 *  1. credentials the platform redactor does not know (private keys, cloud and SaaS API keys, a password-only URL, national ids);
 *  2. `redactPii`: the platform's credential and customer-data masking (bearer/basic, JWT, GitLab tokens, URL credentials,
 *     key=value secrets, e-mail, card numbers, VN phone numbers);
 *  3. matched spans from `looksSecret` (`redactSecretMatches`) are redacted in place rather than replacing whole strings
 *     (with `looksSecret` kept as a final backstop); any non-empty value under a credential-named field (including
 *     numbers, booleans, nested objects/arrays and unanchored field names) is replaced, and object keys are scrubbed too;
 *  4. a snapshot whose entire content was redacted is refused instead of published as `[redacted]`.
 * Request ids, trace ids, IPs, commit SHAs and counts are kept: they are needed to correlate and are not secrets.
 * Idempotent. Bump SCRUB_VERSION when the patterns change: stored rows record the version that scrubbed them.
 */
export const SCRUB_VERSION = 2;
export const REDACTED = "[redacted]";

const EXTRA: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "<private-key>",
  ],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "<aws-key>"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, "<github-token>"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "<slack-token>"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, "<api-key>"],
  [/\bAIza[0-9A-Za-z_-]{35}/g, "<google-key>"],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "<stripe-key>"],
  // redis://:password@host (no user): the platform pattern needs a user before the colon.
  [/(\/\/):[^@\s/]{4,}@/g, "$1:***@"],
  [
    /((?:cccd|cmnd|cmt|căn cước|can cuoc|national[ _-]?id|citizen[ _-]?id)\D{0,20}?)\d{9,12}\b/giu,
    "$1<national-id>",
  ],
];

const normalizeField = (field: string) =>
  field
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s.]+/g, "_")
    .toLowerCase();

const SECRET_FIELD =
  /(?:^|_)(?:passwords?|passwds?|secrets?|client_?secrets?|api_?keys?|access_?keys?|secret_?keys?|private_?keys?|(?:access|refresh|auth|id|bearer|session)_tokens?|(?:access|refresh|auth|id|bearer|session)?_?token|authorization|cookies?|set_?cookies?|dsn|connection_?strings?|database_?urls?)(?:_|$)/;

const isSecretField = (field: string | undefined) =>
  !!field && SECRET_FIELD.test(normalizeField(field));

const REDACTION_ONLY =
  /^(?:\[redacted\]|<(?:private-key|aws-key|github-token|slack-token|api-key|google-key|stripe-key|national-id|jwt|gitlab-token)>|\*{3,})$/;

export function scrubText(s: string): string {
  const masked = redactPii(EXTRA.reduce((acc, [re, rep]) => acc.replace(re, rep), s));
  const spanned = redactSecretMatches(masked, REDACTED);
  return looksSecret(spanned) ? REDACTED : spanned;
}

export function scrubValue(v: unknown, field?: string): unknown {
  const secret = isSecretField(field);
  if (v === null || v === undefined || v === "") return v;
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, field));
  if (typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [scrubText(k), scrubValue(x, secret ? field : k)]),
    );
  if (secret) return REDACTED;
  return typeof v === "string" ? scrubText(v) : v;
}

/** True when redaction occurred and no unredacted non-empty string remains anywhere in the scrubbed value. */
export function isFullyRedacted(v: unknown): boolean {
  let redacted = 0;
  let unredacted = 0;
  const walk = (x: unknown): void => {
    if (typeof x === "string") {
      const t = x.trim();
      if (!t) return;
      if (REDACTION_ONLY.test(t)) redacted++;
      else unredacted++;
      return;
    }
    if (Array.isArray(x)) {
      for (const item of x) walk(item);
      return;
    }
    if (x && typeof x === "object") {
      for (const val of Object.values(x)) walk(val);
    }
  };
  walk(v);
  return redacted > 0 && unredacted === 0;
}

/** Free text a member typed (the assessment focus) is stored in key_parts: scrubbed like a result. */
export const scrubKeyParts = (parts: Record<string, unknown>) =>
  typeof parts.focus === "string" ? { ...parts, focus: scrubText(parts.focus) } : parts;

export function scrubResult(_kind: SharedKind, result: unknown): unknown {
  const out = scrubValue(result);
  if (isFullyRedacted(out)) throw new Error("result completely redacted");
  return out;
}
