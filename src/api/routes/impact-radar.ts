import { latestCoverage, listFindings, radarScan, setFindingStatus } from "../../radar/scan.ts";
import { analyzeImpact } from "../../impact/analyze.ts";
import { HttpError } from "../../http/error.ts";
import { positiveId as num, queryInteger } from "../../http/params.ts";
import { requireAdmin } from "../../authz/access.ts";
import type { Route } from "./types.ts";

export const impactRadarRoutes: Route[] = [
  // Cross-repository impact (src/impact): only repositories the caller can read are analysed and searched.
  [
    "POST",
    /^\/api\/impact\/analyze$/,
    (c) => {
      const kinds = ["kafka_topic", "http_route", "grpc_service", "db_table", "shared_enum"];
      const strs = (v: unknown, n: number) =>
        Array.isArray(v)
          ? v.filter((x): x is string => typeof x === "string").slice(0, n)
          : undefined;
      const contracts = Array.isArray(c.body.contracts)
        ? (c.body.contracts as unknown[]).slice(0, 20).map((x) => {
            const r = (x ?? {}) as { kind?: unknown; key?: unknown };
            if (
              !kinds.includes(String(r.kind)) ||
              typeof r.key !== "string" ||
              !r.key ||
              r.key.length > 200
            )
              throw new HttpError(
                400,
                `contracts: kind must be one of ${kinds.join(", ")} with a key`,
              );
            return { kind: r.kind as "kafka_topic", key: r.key };
          })
        : undefined;
      if (c.body.diff !== undefined && typeof c.body.diff !== "string")
        throw new HttpError(400, "diff must be a string");
      return analyzeImpact(c.actor.id, {
        repository: String(c.body.repository ?? ""),
        diff: c.body.diff as string | undefined,
        files: strs(c.body.files, 200),
        branch: typeof c.body.branch === "string" ? c.body.branch : undefined,
        symbols: strs(c.body.symbols, 20),
        contracts,
      });
    },
  ],
  [
    "GET",
    /^\/api\/impact\/contracts\/([\w.-]+)$/,
    async (c) => {
      const { readableOf } = await import("../../impact/analyze.ts");
      if (!(await readableOf(c.actor.id)).includes(c.p[0])) throw new HttpError(404, "not found");
      const { contractsOf, freshnessOf } = await import("../../impact/index.ts");
      return { freshness: await freshnessOf(c.p[0]), contracts: await contractsOf(c.p[0]) };
    },
  ],
  // Engineering Radar findings (src/radar): administrators only (signatures come from production logs).
  [
    "GET",
    /^\/api\/radar\/findings$/,
    (c) => (
      requireAdmin(c.actor),
      listFindings({
        status: c.url.searchParams.get("status") ?? undefined,
        limit: queryInteger(c.url.searchParams, "limit") ?? 50,
      })
    ),
  ],
  // What the newest radar pass actually evaluated (skipped signatures, partial/stale coverage).
  [
    "GET",
    /^\/api\/radar\/coverage$/,
    async (c) => (requireAdmin(c.actor), (await latestCoverage()) ?? { coverage: null }),
  ],
  [
    "POST",
    /^\/api\/radar\/findings\/(\d+)\/status$/,
    async (c) => {
      requireAdmin(c.actor);
      const status = c.body.status;
      if (status !== "open" && status !== "resolved" && status !== "suppressed")
        throw new HttpError(400, "status must be open, resolved or suppressed");
      const result = await setFindingStatus(num(c.p[0]), status, c.actor.id);
      if (!result.ok) throw new HttpError(404, "radar finding not found");
      return result;
    },
  ],
  [
    "POST",
    /^\/api\/radar\/scan$/,
    async (c) => (
      requireAdmin(c.actor),
      (await radarScan()) ?? { skipped: "another scan is running" }
    ),
  ],
];
