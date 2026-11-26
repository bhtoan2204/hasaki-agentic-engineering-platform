import { redactPii } from "../integrations/redact.ts";
import { looksSecret } from "../knowledge/importer.ts";
import type { SharedKind } from "./types.ts";

/**
 * Scrub policy of a shared snapshot (docs/shared-results/PLAN.md, section 6.3), applied BEFORE anything is stored:
 *  1. credentials the platform redactor does not know (private keys, cloud and SaaS API keys, a password-only URL, national ids);
 *  2. `redactPii`: the platform's credential and customer-data masking (bearer/basic, JWT, GitLab tokens, URL credentials,
 *     key=value secrets, e-mail, card numbers, VN phone numbers);
 *  3. a string that `looksSecret` still flags is replaced whole; so is any string under a field named like a credential.
 * Request ids, trace ids, IPs, commit SHAs and counts are kept: they are needed to correlate and are not secrets.
 * Idempotent. Bump SCRUB_VERSION when the patterns change: stored rows record the version that scrubbed them.
 */
export const SCRUB_VERSION = 1;
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

const SECRET_FIELD =
  /^(?:password|passwd|pwd|secret|client_?secret|api_?key|access_?key|secret_?key|private_?key|(?:access|refresh|auth|id|bearer|session)?_?token|authorization|cookie|set_?cookie|dsn|connection_?string|database_?url)$/i;

export function scrubText(s: string): string {
  const t = redactPii(EXTRA.reduce((acc, [re, rep]) => acc.replace(re, rep), s));
  return looksSecret(t) ? REDACTED : t;
}

export function scrubValue(v: unknown, field?: string): unknown {
  if (typeof v === "string")
    return v && field && SECRET_FIELD.test(field.replace(/-/g, "_")) ? REDACTED : scrubText(v);
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, field));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubValue(x, k)]));
  return v;
}

export const scrubResult = (_kind: SharedKind, result: unknown) => scrubValue(result);
