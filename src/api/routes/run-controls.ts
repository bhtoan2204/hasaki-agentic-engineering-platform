import { findSnapshot } from "../../context/repository.ts";
import { findArtifact, attemptPayload } from "../../workflow/runRepository.ts";
import { HttpError } from "../../http/error.ts";
import { positiveId as num, queryInteger } from "../../http/params.ts";
import {
  audit,
  requireAdmin,
  requireArtifact,
  requireAttempt,
  requireRun,
  requireSnapshot,
} from "../../authz/access.ts";
import {
  closePullRequestAction,
  mergePullRequestAction,
  pullRequestStatus,
  listPullRequests,
} from "../../git/pullRequests.ts";
import {
  AUTO_GATES,
  AUTONOMY_MODES,
  loadPolicies,
  revokePolicy,
  savePolicy,
  setAutonomyPaused,
} from "../../workflow/autonomy.ts";
import { runEvents } from "../../workflow/events.ts";
import { expandSubtasks, EngineError, rejectStep, skipStep } from "../../workflow/engine.ts";
import { addEvidence, removeEvidence } from "../../report/evidenceStore.ts";
import { parseBody } from "../../http/validate.ts";
import { EvidenceBody } from "../../http/schemas.ts";
import type { Route } from "./types.ts";
import { must, support } from "./shared.ts";

export const runControlsRoutes: Route[] = [
  // Autonomy: admins manage the policies; whoever may act on a run can pause or resume its autonomy.
  [
    "GET",
    /^\/api\/autonomy\/policies$/,
    async (c) => (
      requireAdmin(c.actor),
      { policies: await loadPolicies(), modes: AUTONOMY_MODES, gates: AUTO_GATES }
    ),
  ],
  [
    "POST",
    /^\/api\/autonomy\/policies$/,
    async (c) => {
      requireAdmin(c.actor);
      const saved = await savePolicy(c.body, c.actor.username);
      await audit(c.actor.id, "autonomy.policy.save", "autonomy_policy", String(saved.id), {
        scope: `${saved.scope_kind}:${saved.scope_ref}`,
        mode: saved.mode,
        shadow: saved.shadow,
        gates: saved.gates,
        revision: saved.revision,
      });
      return saved;
    },
  ],
  [
    "POST",
    /^\/api\/autonomy\/policies\/(\d+)\/revoke$/,
    async (c) => {
      requireAdmin(c.actor);
      const revoked = await revokePolicy(num(c.p[0]), c.actor.username);
      if (!revoked) throw new EngineError("policy not found or already revoked", 404);
      await audit(c.actor.id, "autonomy.policy.revoke", "autonomy_policy", String(revoked.id), {
        revision: revoked.revision,
      });
      return revoked;
    },
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/autonomy$/,
    async (c) => {
      await requireRun(c.actor, num(c.p[0]), support(c));
      const autonomy = await setAutonomyPaused(num(c.p[0]), c.body.paused === true);
      if (!autonomy) throw new EngineError("this run has no autonomy policy", 404);
      await audit(
        c.actor.id,
        c.body.paused === true ? "autonomy.pause" : "autonomy.resume",
        "run",
        c.p[0],
      );
      return { autonomy };
    },
  ],
  // Expand the run DAG with a decomposition plan (subtasks become durable steps; idempotent, bounded, approval-gated).
  [
    "POST",
    /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/expand$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      expandSubtasks(num(c.p[0]), c.p[1], c.body.plan, {
        by: c.actor.username,
        reason: String(c.body.reason ?? ""),
        kind: c.body.kind === "replan" ? "replan" : "decomposition",
      })
    ),
  ],
  // Evidence for the Task Result Report: a file (base64) or a note, optionally tied to one requirement id (e.g. "S1.R2").
  [
    "POST",
    /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/evidence$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      addEvidence(num(c.p[0]), c.p[1], parseBody(EvidenceBody, c.body))
    ),
  ],
  [
    "POST",
    /^\/api\/artifacts\/(\d+)\/delete-evidence$/,
    async (c) => (
      await requireArtifact(c.actor, num(c.p[0]), support(c)),
      removeEvidence(num(c.p[0]))
    ),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/reject$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      rejectStep(num(c.p[0]), c.p[1], {
        comment: c.body.comment,
        by: c.actor.username,
        reexecute: c.body.reexecute,
      })
    ),
  ],
  [
    "POST",
    /^\/api\/runs\/(\d+)\/steps\/([a-z0-9_-]+)\/skip$/,
    async (c) => (
      await requireRun(c.actor, num(c.p[0]), support(c)),
      skipStep(num(c.p[0]), c.p[1], c.body.reason || "skipped by user")
    ),
  ],
  [
    "GET",
    /^\/api\/attempts\/(\d+)\/transcript$/,
    async (c) => (
      await requireAttempt(c.actor, num(c.p[0]), support(c)),
      runEvents.transcript(num(c.p[0]), queryInteger(c.url.searchParams, "after") ?? 0)
    ),
  ],
  [
    "GET",
    /^\/api\/artifacts\/(\d+)$/,
    async (c) => (
      await requireArtifact(c.actor, num(c.p[0]), support(c)),
      must(await findArtifact(num(c.p[0])), "artifact")
    ),
  ],
  [
    "GET",
    /^\/api\/attempts\/(\d+)\/(input|output)$/,
    async (c) => {
      await requireAttempt(c.actor, num(c.p[0]), support(c));
      const value = await attemptPayload(num(c.p[0]), c.p[1] === "input" ? "input" : "output");
      if (value === undefined) throw new HttpError(404, "attempt not found");
      return value;
    },
  ],
  [
    "GET",
    /^\/api\/snapshots\/(\d+)$/,
    async (c) => (
      await requireSnapshot(c.actor, num(c.p[0]), support(c)),
      must(await findSnapshot(num(c.p[0])), "snapshot")
    ),
  ],
  ["GET", /^\/api\/pull-requests$/, (c) => listPullRequests(c.actor.id, support(c))],
  // Merge readiness and CI of one PR/MR (read-only; run owner only).
  [
    "GET",
    /^\/api\/pull-requests\/(\d+)\/status$/,
    (c) => pullRequestStatus(c.actor.id, num(c.p[0])),
  ],
  // Human-only merge/close. Re-checked against the owner's permission and the host's mergeability, approvals and
  // required pipeline at the moment of the action; no agent tool or engine path reaches these.
  [
    "POST",
    /^\/api\/pull-requests\/(\d+)\/(merge|close)$/,
    async (c) => {
      const id = num(c.p[0]);
      let result;
      try {
        result =
          c.p[1] === "merge"
            ? await mergePullRequestAction(c.actor.id, id)
            : await closePullRequestAction(c.actor.id, id);
      } catch (e) {
        // Refusals (permission, policy, provider) are audited too, with the reason only.
        await audit(c.actor.id, `pull_request.${c.p[1]}_refused`, "pull_request", String(id), {
          reason: String((e as Error).message).slice(0, 500),
        });
        throw e;
      }
      await audit(c.actor.id, `pull_request.${c.p[1]}`, "pull_request", String(id), result);
      return result;
    },
  ],
];
