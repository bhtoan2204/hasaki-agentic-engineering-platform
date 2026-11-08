import { HttpError } from "../../http/error.ts";
import { AGENT_PROVIDERS } from "../../agent/provider.ts";

export const DIMENSIONS = ["provider", "model", "user", "workflow", "repository", "project"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export interface AnalyticsFilters {
  from: string;
  to: string;
  timezone: string;
  bucket: "hour" | "day";
  provider: string | null;
  model: string | null;
  user: number | null;
  workflow: string | null;
  repository: string | null;
  project: string | null;
  service: string | null;
  groupBy: Dimension;
  page: number;
  pageSize: number;
}
export interface AnalyticsScope {
  ownerId: number;
  all: boolean;
}
const bad = (message: string): never => {
  throw new HttpError(400, message);
};
export function parseAnalyticsFilters(p: URLSearchParams, now = new Date()): AnalyticsFilters {
  const date = (key: string, fallback: string) => {
    const value = p.get(key) || fallback;
    if (
      !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) ||
      !Number.isFinite(Date.parse(value))
    )
      bad(`Invalid ${key}: use a date or ISO timestamp with offset`);
    if (value.slice(0, 10) !== new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10))
      bad(`Invalid ${key}`);
    return value;
  };
  const end = new Date(now);
  end.setUTCSeconds(0, 0);
  const from = date("from", new Date(end.getTime() - 30 * 86400000).toISOString());
  const to = date("to", end.toISOString());
  const span = Date.parse(to) - Date.parse(from);
  if (span <= 0 || span > 366 * 86400000 + 2 * 3600000) bad("Date range must be positive and at most 366 days");
  const timezone = p.get("timezone") || "Asia/Bangkok";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(now);
  } catch {
    bad("Invalid timezone");
  }
  const text = (key: string) => {
    const v = p.get(key)?.trim() || null;
    if (v && v.length > 160) bad(`Invalid ${key}`);
    return v;
  };
  const provider = text("provider");
  if (provider && !(AGENT_PROVIDERS as readonly string[]).includes(provider)) bad("Invalid provider");
  const integer = (key: string, fallback: number, max: number) => {
    const value = p.has(key) ? Number(p.get(key)) : fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) bad(`Invalid ${key}`);
    return value;
  };
  const bucket = p.get("bucket") || "day";
  if (bucket !== "hour" && bucket !== "day") bad("Invalid bucket");
  if (bucket === "hour" && span > 31 * 86400000) bad("Hourly ranges are limited to 31 days");
  const groupBy = p.get("group_by") || "provider";
  if (!(DIMENSIONS as readonly string[]).includes(groupBy)) bad("Invalid group_by");
  return {
    from,
    to,
    timezone,
    bucket: bucket as "hour" | "day",
    provider,
    model: text("model"),
    user: p.has("user") ? integer("user", 0, Number.MAX_SAFE_INTEGER) : null,
    workflow: text("workflow"),
    repository: text("repository"),
    project: text("project"),
    service: text("service"),
    groupBy: groupBy as Dimension,
    page: integer("page", 1, 10000),
    pageSize: integer("page_size", 25, 100),
  };
}
/** Date-only boundaries use the requested timezone; timestamp boundaries keep their explicit offset. [from,to). */
export const boundsSql = `bounds AS (SELECT $4::text AS bucket,
  CASE WHEN length($1::text)=10 THEN $1::timestamp AT TIME ZONE $3 ELSE $1::timestamptz END AS lo,
  CASE WHEN length($2::text)=10 THEN $2::timestamp AT TIME ZONE $3 ELSE $2::timestamptz END AS hi)`;
export const bucketSql = (field: string) => `date_trunc($4::text, ${field}, $3)`;
export function filterParams(f: AnalyticsFilters, s: AnalyticsScope): unknown[] {
  return [
    f.from,
    f.to,
    f.timezone,
    f.bucket,
    s.ownerId,
    s.all,
    f.provider,
    f.model,
    f.user,
    f.workflow,
    f.repository,
    f.project,
    f.service,
  ];
}
