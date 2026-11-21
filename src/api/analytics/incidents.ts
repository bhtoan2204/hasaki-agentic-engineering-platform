import { one, q, withTx } from "../../db/pool.ts";
import { HttpError } from "../../http/error.ts";
import { requireAdmin, type Actor } from "../../authz/access.ts";
import { safeDiagnostics } from "../../agent/telemetry.ts";

/** Incident lifecycle writes from the health dashboard (the dashboards themselves are read by platform-go). */
export async function updateIncidentLifecycle(
  actor: Actor,
  fingerprint: string,
  body: { action?: unknown; evidence?: unknown },
) {
  requireAdmin(actor);
  const action = body.action;
  if (action !== "acknowledge" && action !== "resolve" && action !== "reopen")
    throw new HttpError(400, "Invalid lifecycle action");
  const evidence = safeDiagnostics(String(body.evidence ?? "").trim());
  if (action === "resolve" && evidence.length < 8)
    throw new HttpError(
      400,
      "Resolution requires an evidence reference or explanation (8–4000 characters)",
    );
  return withTx(async (c) => {
    const g = await one(c, "SELECT * FROM prod_error_groups WHERE fingerprint=$1 FOR UPDATE", [
      fingerprint,
    ]);
    if (!g) throw new HttpError(404, "Incident not found");
    const next =
      action === "resolve" ? "resolved" : action === "acknowledge" ? "acknowledged" : "open";
    if (g.lifecycle_status === next) return { ok: true, status: next };
    if (action === "acknowledge" && g.lifecycle_status === "resolved")
      throw new HttpError(409, "Reopen a resolved incident first");
    await q(
      c,
      `UPDATE prod_error_groups SET lifecycle_status=$2,
      acknowledged_at=CASE WHEN $3='acknowledge' THEN COALESCE(acknowledged_at,now()) ELSE acknowledged_at END,
      resolved_at=CASE WHEN $3='resolve' THEN now() WHEN $3='reopen' THEN NULL ELSE resolved_at END,updated_at=now() WHERE fingerprint=$1`,
      [fingerprint, next, action],
    );
    await q(
      c,
      "INSERT INTO prod_error_lifecycle_events(fingerprint,action,actor_id,evidence) VALUES($1,$2,$3,$4)",
      [fingerprint, action, actor.id, evidence],
    );
    await q(
      c,
      "INSERT INTO audit_log(actor_id,action,resource_type,resource_id,detail) VALUES($1,$2,'prod_error',$3,$4)",
      [actor.id, `incident.${action}`, fingerprint, JSON.stringify({ evidence })],
    );
    return { ok: true, status: next };
  });
}
