import { pool, q } from "../db/pool.ts";
import { runChanges } from "../git/changes.ts";
import type { EvidenceKind } from "./aiSuggest.ts";

/**
 * Deterministic evidence catalogue for a run: what the workflow actually produced (step outputs, test results, logs,
 * commits, changed files, PRs, review) plus evidence the user attached to the report step. Every item has a stable id
 * and a reference back to its source so the report never cites something that does not exist.
 */
export interface Evidence {
  id: string;
  kind: EvidenceKind;
  title: string;
  detail: string;
  ref: { step_key?: string; artifact_id?: number; url?: string; commit?: string; repo?: string; path?: string };
  /** Only for uploads: the requirement the user attached it to. */
  requirement_id?: string | null;
  image?: boolean;
  /** test_result: did it pass (baseline-aware when available)? */
  passed?: boolean;
  /** uploaded before the latest upstream change (may describe superseded code). */
  stale?: boolean;
  /** task attachments describe the problem, not the fix: context only, never proof. */
  before_fix?: boolean;
  at?: string;
}

const clip = (s: unknown, n = 600) => {
  const t = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return t.length > n ? t.slice(0, n) + "…" : t;
};

export async function collectEvidence(runId: number, reportStepId: number): Promise<Evidence[]> {
  const ev: Evidence[] = [];
  let n = 0;
  const add = (e: Omit<Evidence, "id">) => ev.push({ id: `E${++n}`, ...e });

  const steps = await q(
    pool,
    `SELECT id, key, name, type, status, output, finished_at FROM workflow_steps WHERE run_id = $1 AND id <> $2 ORDER BY position`,
    [runId, reportStepId],
  );
  const latestUpstream = steps.reduce((m: number, s: any) => Math.max(m, s.finished_at ? new Date(s.finished_at).getTime() : 0), 0);

  for (const s of steps) {
    if (s.status !== "COMPLETED" || !s.output || s.output.skipped) continue;
    const o = s.output;
    switch (s.type) {
      case "coding_agent":
        add({ kind: "implementation_summary", title: `${s.name}: implementation summary`, detail: clip([o.summary, o.verification].filter(Boolean).join("\n"), 1500), ref: { step_key: s.key }, at: s.finished_at });
        break;
      case "agent":
        if ("approved" in o || "findings" in o)
          add({ kind: "review", title: `${s.name}: ${o.approved === false ? "changes requested" : o.approved === true ? "approved" : "review"}`, detail: clip({ summary: o.summary, findings: o.findings }, 1200), ref: { step_key: s.key }, at: s.finished_at });
        else add({ kind: "analysis", title: `${s.name}`, detail: clip(o.summary ?? o.root_cause ?? o.goal ?? o, 800), ref: { step_key: s.key }, at: s.finished_at });
        break;
      case "command":
        for (const r of o.results ?? [])
          add({
            kind: "test_result",
            title: `${s.name} · ${r.repo}: ${r.passed ?? r.exit_code === 0 ? "passed" : "failed"}${r.baseline ? ` (${r.baseline.regressions?.length ?? "?"} regressions vs base, ${r.baseline.pre_existing?.length ?? 0} pre-existing)` : ""}`,
            detail: clip(r.baseline ?? { exit_code: r.exit_code }, 800),
            ref: { step_key: s.key, artifact_id: r.artifact_id, repo: r.repo },
            passed: r.passed ?? r.exit_code === 0,
            at: s.finished_at,
          });
        break;
      case "git_pull_request":
        for (const p of o.pull_requests ?? []) add({ kind: "pr", title: `PR ${p.repo}${p.draft ? " (draft)" : ""}`, detail: p.note ?? "", ref: { step_key: s.key, url: p.url, repo: p.repo }, at: s.finished_at });
        break;
      case "human_input":
        add({ kind: "human_decision", title: `${s.name}: answers`, detail: clip(o.answers, 800), ref: { step_key: s.key }, at: s.finished_at });
        break;
      case "human_approval":
        if (o.comment) add({ kind: "human_decision", title: `${s.name}: approved`, detail: clip(o.comment, 400), ref: { step_key: s.key }, at: s.finished_at });
        break;
    }
  }

  // Git: commits and changed files of every worktree (read-only).
  try {
    const ch = await runChanges(runId);
    for (const r of ch.repos as any[]) {
      if (!r.exists) continue;
      for (const c of r.commits ?? []) add({ kind: "commit", title: `${r.repo} ${c.hash} ${c.subject}`, detail: `${c.author}, ${c.when}`, ref: { repo: r.repo, commit: c.hash } });
      for (const f of r.files ?? []) {
        const diff = fileDiff(r.diff ?? "", f.path);
        add({ kind: "file_change", title: `${r.repo}/${f.path} (+${f.additions ?? "bin"} −${f.deletions ?? "bin"})`, detail: clip(diff, 1500), ref: { repo: r.repo, path: f.path } });
      }
    }
  } catch {}

  // Artifacts of current (non-invalidated) attempts: command logs, review reports.
  for (const a of await q(
    pool,
    `SELECT a.id, a.kind, a.name, left(a.content, 1200) AS excerpt, a.data, s.key AS step_key, a.created_at
       FROM workflow_artifacts a JOIN workflow_steps s ON s.id = a.step_id LEFT JOIN workflow_step_attempts t ON t.id = a.attempt_id
      WHERE a.run_id = $1 AND a.step_id <> $2 AND a.kind IN ('log', 'report') AND (t.id IS NULL OR t.invalidated_at IS NULL)
      ORDER BY a.id`,
    [runId, reportStepId],
  ))
    add({ kind: "log", title: `${a.step_key}: ${a.name}${a.data?.exit_code != null ? ` (exit ${a.data.exit_code})` : ""}`, detail: a.excerpt, ref: { step_key: a.step_key, artifact_id: a.id }, at: a.created_at });

  // Evidence attached by the user to the report step (survives regeneration and restarts).
  for (const a of await q(pool, `SELECT id, name, content, data, created_at FROM workflow_artifacts WHERE step_id = $1 AND kind = 'evidence' ORDER BY id`, [reportStepId])) {
    const d = a.data ?? {};
    const image = String(d.mime ?? "").startsWith("image/");
    add({
      kind: d.note_only ? "note" : image ? "screenshot" : "attachment",
      title: d.note_only ? `Ghi chú: ${clip(a.content, 120)}` : `${image ? "Ảnh" : "File"}: ${a.name}`,
      detail: d.note_only ? a.content : clip(d.note ?? "", 600),
      ref: { artifact_id: a.id },
      requirement_id: d.requirement_id ?? null,
      image,
      stale: latestUpstream > new Date(a.created_at).getTime(),
      at: a.created_at,
    });
  }

  // Task attachments (screenshots of the original problem): context, never proof of the fix.
  const wi = (await q(pool, "SELECT w.payload FROM workflow_runs r JOIN work_items w ON w.id = r.work_item_id WHERE r.id = $1", [runId]))[0];
  for (const f of wi?.payload?.note_files ?? []) add({ kind: "task_attachment", title: `Task attachment ${f}`, detail: "attached to the task before the fix", ref: { path: f }, before_fix: true });
  return ev;
}

function fileDiff(diff: string, path: string) {
  return diff.split(/^(?=diff --git )/m).find((p) => p.startsWith("diff --git") && p.includes(` b/${path}`)) ?? "";
}
