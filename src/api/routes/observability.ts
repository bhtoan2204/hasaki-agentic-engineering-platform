import { config } from "../../config.ts";
import { argoStatus, clearArgoToken, setArgoToken } from "../../integrations/argocd.ts";
import {
  clearSharedSplunkToken,
  clearSplunkCookie,
  setSharedSplunkToken,
  setSplunkCookie,
  setSplunkToken,
  splunkStatus,
  splunkTestConnection,
} from "../../integrations/splunk.ts";
import {
  databasesForRun,
  deleteDatabase,
  publicDatabases,
  saveDatabase,
  testDatabase,
} from "../../integrations/database.ts";
import {
  getIncidentDetail,
  investigate,
  listGroups,
  saveSettings as saveProdErrorSettings,
  setIgnored,
  startScan,
  type ScanPreset,
} from "../../prodErrors/scan.ts";
import { cancelScan } from "../../prodErrors/jobs.ts";
import { HttpError } from "../../http/error.ts";
import {
  disconnectSignoz,
  saveSignoz,
  SignozError,
  signozStatus,
  testSignoz,
} from "../../integrations/signoz.ts";
import { audit, requireAdmin, type Actor } from "../../authz/access.ts";
import { loadStoredSlopSettings, saveSlopSettings } from "../../slop/policy.ts";
import { repositories } from "../../repos/service.ts";
import { listAccessibleRepositories } from "../../repos/access.ts";
import { parseBody } from "../../http/validate.ts";
import { CookieBody, TokenBody } from "../../http/schemas.ts";
import type { Route } from "./types.ts";
import { type IncidentGroupLinks, support } from "./shared.ts";

function redactGroup<G extends IncidentGroupLinks>(
  group: G | null | undefined,
  actor: Actor,
  showAll: boolean,
) {
  if (!group?.work_item_id) return group;
  const ownerId = group.work_item_owner_id == null ? null : Number(group.work_item_owner_id);
  if (ownerId === actor.id || (showAll && actor.role === "admin" && ownerId != null)) return group;
  const {
    work_item_id: _work_item_id,
    work_item_code: _work_item_code,
    work_item_title: _work_item_title,
    work_item_status: _work_item_status,
    work_item_owner_id: _work_item_owner_id,
    run_id: _run_id,
    run_status: _run_status,
    pull_requests: _pull_requests,
    ...rest
  } = group;
  return { ...rest, work_item_id: null, run_id: null, pull_requests: [] };
}

export const observabilityRoutes: Route[] = [
  // ------------------------------------------------------------ Argo CD (QC logs): pasted token, read-only
  // Project QC databases (read-only for agents): admins manage connections; a member sees the ones their access permits.
  [
    "GET",
    /^\/api\/integrations\/databases$/,
    async ({ actor }) => {
      if (actor.role === "admin") return publicDatabases();
      const mine = (await listAccessibleRepositories(actor.id)).map((m) => m.repository.name);
      // Status without technical details (host, account, raw error): those stay with admins.
      return (await databasesForRun(mine)).map((d) => ({
        key: d.key,
        project: d.project,
        environment: d.environment,
        engine: d.engine,
        database_name: d.database_name,
        repositories: d.repositories,
        description: d.description,
        last_status: d.last_status ?? null,
        last_checked_at: d.last_checked_at ?? null,
        last_used_at: d.last_used_at ?? null,
        last_error_kind: d.last_error_kind ?? null,
        last_latency_ms: d.last_latency_ms ?? null,
      }));
    },
  ],
  [
    "POST",
    /^\/api\/integrations\/databases$/,
    async ({ body, actor }) => {
      requireAdmin(actor);
      const r = await saveDatabase(body, actor.id);
      await audit(
        actor.id,
        r.created ? "database.create" : "database.update",
        "project_database",
        r.key,
        {
          project: r.project,
          host: r.host,
          database: r.database_name,
          password_changed: !!body.password,
        },
      );
      return r;
    },
  ],
  [
    "POST",
    /^\/api\/integrations\/databases\/([a-z0-9_-]+)\/test$/,
    async ({ p, actor }) => (requireAdmin(actor), testDatabase(p[0])),
  ],
  [
    "POST",
    /^\/api\/integrations\/databases\/([a-z0-9_-]+)\/delete$/,
    async ({ p, actor }) => {
      requireAdmin(actor);
      if (!(await deleteDatabase(p[0]))) throw new HttpError(404, "database not found");
      await audit(actor.id, "database.delete", "project_database", p[0]);
      return { ok: true };
    },
  ],
  ["GET", /^\/api\/integrations\/argocd$/, () => argoStatus()],
  [
    "POST",
    /^\/api\/integrations\/argocd\/token$/,
    ({ body }) => setArgoToken(parseBody(TokenBody, body).token),
  ],
  ["POST", /^\/api\/integrations\/argocd\/logout$/, () => clearArgoToken()],
  // Splunk (production SIEM): pasted session cookie, read-only searches
  [
    "GET",
    /^\/api\/integrations\/splunk$/,
    ({ url }) => splunkStatus(url.searchParams.get("check") === "1"),
  ],
  [
    "POST",
    /^\/api\/integrations\/splunk\/cookie$/,
    ({ body }) => setSplunkCookie(parseBody(CookieBody, body).cookie),
  ],
  ["POST", /^\/api\/integrations\/splunk\/logout$/, () => clearSplunkCookie()],
  [
    "POST",
    /^\/api\/integrations\/splunk\/token$/,
    ({ body }) => setSplunkToken(parseBody(TokenBody, body).token),
  ],
  ["POST", /^\/api\/integrations\/splunk\/test$/, () => splunkTestConnection()],
  // Shared read-only service account: administrators only; members use it only when splunk.allowSharedToken is on.
  [
    "POST",
    /^\/api\/integrations\/splunk\/shared$/,
    async ({ body, actor }) => {
      requireAdmin(actor);
      await audit(actor.id, "integration.splunk.shared_token", "integration", "splunk");
      return setSharedSplunkToken(parseBody(TokenBody, body).token);
    },
  ],
  [
    "POST",
    /^\/api\/integrations\/splunk\/shared\/clear$/,
    async ({ actor }) => {
      requireAdmin(actor);
      await audit(actor.id, "integration.splunk.shared_token_clear", "integration", "splunk");
      return clearSharedSplunkToken();
    },
  ],
  // SigNoz: each user's own domain and API key or session tokens (encrypted); credentials are never returned.
  ["GET", /^\/api\/integrations\/signoz$/, () => signozStatus()],
  [
    "POST",
    /^\/api\/integrations\/signoz$/,
    async ({ body, actor }) => {
      try {
        const status = await saveSignoz(body);
        await audit(actor.id, "integration.signoz.save", "integration", "signoz", {
          base_url: status.base_url,
          enabled: status.enabled,
          auth: status.auth,
          token_changed: ["token", "accessToken", "refreshToken"].some(
            (k) => typeof body[k] === "string" && !!body[k].trim(),
          ),
        });
        return status;
      } catch (e) {
        if (e instanceof SignozError) {
          await audit(actor.id, "integration.signoz.save_failed", "integration", "signoz", {
            kind: e.kind,
          });
          throw new HttpError(400, e.message);
        }
        throw e;
      }
    },
  ],
  [
    "POST",
    /^\/api\/integrations\/signoz\/test$/,
    async ({ actor }) => {
      const result = await testSignoz();
      await audit(actor.id, "integration.signoz.test", "integration", "signoz", {
        ok: result.ok,
        ...(result.ok ? {} : { kind: result.kind }),
      });
      return result;
    },
  ],
  [
    "POST",
    /^\/api\/integrations\/signoz\/disconnect$/,
    async ({ actor }) => {
      await audit(actor.id, "integration.signoz.disconnect", "integration", "signoz");
      return disconnectSignoz();
    },
  ],
  [
    "GET",
    /^\/api\/prod-errors$/,
    async (c) => {
      const data = await listGroups({
        day: c.url.searchParams.get("day") ?? undefined,
        all: c.url.searchParams.get("all") === "1",
      });
      return {
        ...data,
        groups: (data.groups ?? []).map((g) => redactGroup(g, c.actor, support(c))),
      };
    },
  ],
  [
    "GET",
    /^\/api\/prod-errors\/([0-9a-f]{20})$/,
    async (c) => {
      const data = await getIncidentDetail(c.p[0]);
      return { ...data, group: redactGroup(data.group, c.actor, support(c)) };
    },
  ],
  [
    "POST",
    /^\/api\/prod-errors\/scan$/,
    ({ actor, body }) => (
      requireAdmin(actor),
      startScan("manual", {
        namespaces: Array.isArray(body.namespaces) ? body.namespaces.map(String) : undefined,
        preset: body.preset ? (String(body.preset) as ScanPreset) : undefined,
        from: body.from ? String(body.from) : undefined,
        to: body.to ? String(body.to) : undefined,
      })
    ),
  ],
  [
    "POST",
    /^\/api\/prod-errors\/scans\/(\d+)\/cancel$/,
    async ({ p, actor }) => {
      requireAdmin(actor);
      await audit(actor.id, "prod_errors.scan.cancel", "prod_error_scan", p[0]);
      return cancelScan(Number(p[0]));
    },
  ],
  [
    "GET",
    /^\/api\/slop\/settings$/,
    async () => ({ defaults: config.slop, stored: await loadStoredSlopSettings() }),
  ],
  [
    "POST",
    /^\/api\/slop\/settings$/,
    async ({ body, actor }) => (
      requireAdmin(actor),
      saveSlopSettings(
        body,
        (await repositories.list()).map((r) => r.name),
      )
    ),
  ],
  [
    "POST",
    /^\/api\/prod-errors\/settings$/,
    ({ body, actor }) => (requireAdmin(actor), saveProdErrorSettings(body)),
  ],
  [
    "POST",
    /^\/api\/prod-errors\/([0-9a-f]{20})\/ignore$/,
    ({ p, body, actor }) => (
      requireAdmin(actor),
      setIgnored(p[0], body.ignored !== false, {
        days:
          Number.isFinite(Number(body.days)) && Number(body.days) > 0
            ? Number(body.days)
            : undefined,
      })
    ),
  ],
  [
    "POST",
    /^\/api\/prod-errors\/([0-9a-f]{20})\/investigate$/,
    ({ p, actor }) => investigate(p[0], actor.id),
  ],
];
