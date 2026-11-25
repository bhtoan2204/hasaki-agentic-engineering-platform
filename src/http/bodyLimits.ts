/** Request body ceilings (bytes). Every JSON body is bounded; a route that needs more is listed in ROUTE_BODY_LIMITS. */
export const DEFAULT_BODY_LIMIT = 1024 * 1024;
/** Unauthenticated or credential-bearing routes carry a few short fields. */
export const AUTH_BODY_LIMIT = 16 * 1024;
export const TELEGRAM_WEBHOOK_BODY_LIMIT = 262_144;
/** A 10 MB file as base64 plus the JSON envelope (chat attachments, report-step evidence). */
export const UPLOAD_BODY_LIMIT = 14_200_000;

/**
 * Per-route overrides, first match wins. Audited against src/api/routes.ts: only these POSTs legitimately exceed 1 MiB
 * (file uploads; impact analysis accepts a diff of up to 512 KiB, which JSON escaping can inflate).
 */
export const ROUTE_BODY_LIMITS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^\/api\/auth\/(?:login|password)$/, AUTH_BODY_LIMIT],
  [/^\/api\/users\/\d+\/password$/, AUTH_BODY_LIMIT],
  [/^\/api\/chat\/conversations\/\d+\/attachments$/, UPLOAD_BODY_LIMIT],
  [/^\/api\/runs\/\d+\/steps\/[a-z0-9_-]+\/evidence$/, UPLOAD_BODY_LIMIT],
  [/^\/api\/impact\/analyze$/, 2 * 1024 * 1024],
];

export function bodyLimitFor(pathname: string): number {
  for (const [pattern, limit] of ROUTE_BODY_LIMITS) if (pattern.test(pathname)) return limit;
  return DEFAULT_BODY_LIMIT;
}
