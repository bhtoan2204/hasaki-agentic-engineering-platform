import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { config } from "../config.ts";
import { pool, q, one, json } from "../db/pool.ts";
import { repoPath, repositories } from "../repos/service.ts";

/**
 * "What did this run do?" — a detailed, factual summary of a finished run, shown on the work item page.
 *
 * Built only from what the run recorded (step outputs written by the agents, test results, commits on the run's
 * branches, PRs, questions answered, approvals, failed attempts, metrics). No extra model call: nothing is invented and
 * it costs nothing. A snapshot is stored on the run when it finishes, so it survives worktree cleanup.
 */

const exec = promisify(execFile);
const SUMMARY_VERSION = 1;

export interface SummaryList {
  label: string;
  items: string[];
}
export interface StepSummary {
  key: string;
  name: string;
  type: string;
  status: string;
  attempts: number;
  duration_ms: number | null;
  summary: string;
  lists: SummaryList[];
}
export interface RepoChange {
  repo: string;
  branch: string;
  base: string;
  commits: Array<{ hash: string; subject: string }>;
  files: Array<{ path: string; additions: number | null; deletions: number | null }>;
  additions: number;
  deletions: number;
  note?: string;
}
export interface RunSummary {
  version: number;
  generated_at: string;
  run: { id: number; title: string; status: string; workflow: string; agent_provider: string; started_at: string | null; finished_at: string | null; duration_ms: number | null; error: string | null };
  totals: { steps_run: number; attempts: number; retries: number; agent_turns: number; tool_calls: number; cost_usd: number | null; tokens_in: number; tokens_out: number };
  steps: StepSummary[];
  changes: RepoChange[];
  tests: Array<{ step: string; repo: string; passed: boolean; skipped?: boolean; detail: string }>;
  pull_requests: Array<{ repo: string; url: string; title: string; source_branch: string; target_branch: string; draft: boolean }>;
  decisions: Array<{ kind: "answer" | "approval"; step: string; question: string; answer: string; by: string | null; at: string | null }>;
  problems: Array<{ step: string; attempt: number; status: string; message: string }>;
  markdown: string;
}

/** Output fields agents commonly fill, in display order, with the label shown in the summary. */
const LIST_FIELDS: Array<[string, { vi: string; en: string }]> = [
  ["goal", { vi: "Mục tiêu", en: "Goal" }],
  ["requirements", { vi: "Yêu cầu", en: "Requirements" }],
  ["acceptance_criteria", { vi: "Tiêu chí chấp nhận", en: "Acceptance criteria" }],
  ["root_cause", { vi: "Nguyên nhân gốc", en: "Root cause" }],
  ["findings", { vi: "Phát hiện", en: "Findings" }],
  ["changes", { vi: "Thay đổi", en: "Changes" }],
  ["tests", { vi: "Kiểm thử", en: "Tests" }],
  ["verification", { vi: "Xác minh", en: "Verification" }],
  ["risks", { vi: "Rủi ro", en: "Risks" }],
  ["unknowns", { vi: "Chưa rõ", en: "Unknowns" }],
  ["limitations", { vi: "Giới hạn", en: "Limitations" }],
  ["next_steps", { vi: "Bước tiếp theo", en: "Next steps" }],
];

const clip = (s: string, n = 600) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** One readable line for a list item an agent produced (string, or an object such as a finding). */
function itemText(x: unknown): string {
  if (x == null) return "";
  if (typeof x === "string") return clip(x.trim());
  if (typeof x !== "object") return String(x);
  const o = x as Record<string, unknown>;
  const main = [o.issue, o.text, o.title, o.description, o.summary, o.requirement, o.risk, o.change, o.name, o.what].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  const where = typeof o.file === "string" ? `${o.file}${o.line ? `:${o.line}` : ""}` : typeof o.path === "string" ? o.path : "";
  const sev = typeof o.severity === "string" ? `[${o.severity}] ` : "";
  if (main) return clip(`${sev}${main}${where ? ` (${where})` : ""}`);
  return clip(JSON.stringify(o), 300);
}

function listsOf(output: Record<string, unknown>, en: boolean): SummaryList[] {
  const lists: SummaryList[] = [];
  for (const [field, label] of LIST_FIELDS) {
    const v = output[field];
    const items = (Array.isArray(v) ? v.map(itemText) : typeof v === "string" ? [clip(v.trim())] : v && typeof v === "object" ? [itemText(v)] : []).filter(Boolean);
    if (items.length) lists.push({ label: en ? label.en : label.vi, items: items.slice(0, 15) });
  }
  return lists;
}

function stepSummaryText(type: string, output: Record<string, any>, en: boolean): string {
  if (typeof output.summary === "string" && output.summary.trim()) return output.summary.trim();
  if (typeof output.diagnosis?.summary === "string") return output.diagnosis.summary;
  if (type === "human_approval") {
    const who = output.by ? (en ? ` by ${output.by}` : ` bởi ${output.by}`) : "";
    const verdict = output.approved === false ? (en ? "Rejected" : "Từ chối") : output.auto ? (en ? "Auto-approved" : "Tự động duyệt") : en ? "Approved" : "Đã duyệt";
    return `${verdict}${who}${output.comment ? ` — ${output.comment}` : ""}`;
  }
  if (type === "integration" && Array.isArray(output.selected_repositories))
    return `${en ? "Repositories" : "Repo"}: ${output.selected_repositories.join(", ") || "—"}${output.method ? ` (${output.method})` : ""}`;
  if (type === "command") {
    if (output.skipped) return `${en ? "Skipped" : "Bỏ qua"}: ${output.reason ?? ""}`.trim();
    if (typeof output.passed === "boolean") return output.passed ? (en ? "Tests passed" : "Test đạt") : en ? "Tests failed" : "Test không đạt";
  }
  if (type === "git_pull_request") {
    const n = Array.isArray(output.pull_requests) ? output.pull_requests.length : 0;
    return n ? (en ? `${n} pull request(s)` : `${n} pull request`) : String(output.note ?? (en ? "No pull request" : "Không tạo pull request"));
  }
  for (const k of ["note", "reason", "message", "result"]) if (typeof output[k] === "string" && output[k].trim()) return output[k].trim();
  return "";
}

async function git(cwd: string, ...args: string[]) {
  const { stdout } = await exec("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** Commits and files on the run's branch vs the base, read from the main checkout (works after worktree removal). */
async function changesOf(runId: number): Promise<RepoChange[]> {
  const ws = await q<{ repo: string; branch: string; path: string }>(pool, "SELECT repo, branch, path FROM execution_workspaces WHERE run_id = $1 ORDER BY repo", [runId]);
  const out: RepoChange[] = [];
  for (const w of ws) {
    const reg = await repositories.get(w.repo);
    const dir = [reg ? repoPath(reg) : "", w.path].find((d) => d && existsSync(d));
    const base = `origin/${config.baseBranch}`;
    const change: RepoChange = { repo: w.repo, branch: w.branch, base, commits: [], files: [], additions: 0, deletions: 0 };
    if (!dir) {
      out.push({ ...change, note: "repository not available on this machine" });
      continue;
    }
    try {
      const [log, numstat] = await Promise.all([git(dir, "log", "--format=%h%x09%s", `${base}..${w.branch}`), git(dir, "diff", "--numstat", `${base}...${w.branch}`)]);
      change.commits = log.trim() ? log.trim().split("\n").map((l) => { const [hash, ...s] = l.split("\t"); return { hash, subject: s.join("\t") }; }) : [];
      change.files = numstat.trim() ? numstat.trim().split("\n").map((l) => {
        const [a, d, ...p] = l.split("\t");
        return { path: p.join("\t"), additions: a === "-" ? null : Number(a), deletions: d === "-" ? null : Number(d) };
      }) : [];
      change.additions = change.files.reduce((n, f) => n + (f.additions ?? 0), 0);
      change.deletions = change.files.reduce((n, f) => n + (f.deletions ?? 0), 0);
    } catch (e) {
      change.note = `git: ${(e as Error).message.split("\n")[0].slice(0, 200)}`;
    }
    out.push(change);
  }
  return out;
}

export async function buildRunSummary(runId: number): Promise<RunSummary> {
  const run = await one(pool, "SELECT * FROM workflow_runs WHERE id = $1", [runId]);
  if (!run) throw Object.assign(new Error(`run ${runId} not found`), { status: 404 });
  const en = run.output_locale === "en";
  const steps = await q(pool, "SELECT * FROM workflow_steps WHERE run_id = $1 ORDER BY position", [runId]);
  const attempts = await q(pool, "SELECT * FROM workflow_step_attempts WHERE run_id = $1 ORDER BY id", [runId]);
  const byStep = new Map<number, any[]>();
  for (const a of attempts) byStep.set(a.step_id, [...(byStep.get(a.step_id) ?? []), a]);

  const stepLines: StepSummary[] = [];
  for (const s of steps) {
    const tries = byStep.get(s.id) ?? [];
    if (!tries.length && !["COMPLETED", "FAILED", "SKIPPED"].includes(s.status)) continue; // never ran
    const output = (s.output && typeof s.output === "object" ? s.output : {}) as Record<string, any>;
    const counted = tries.filter((a) => a.status !== "STALE");
    const duration = counted.reduce((n, a) => n + (a.started_at && a.finished_at ? new Date(a.finished_at).getTime() - new Date(a.started_at).getTime() : 0), 0);
    stepLines.push({
      key: s.key,
      name: s.name,
      type: s.type,
      status: s.status,
      attempts: counted.length,
      duration_ms: duration || null,
      summary: s.status === "FAILED" && s.error ? `${en ? "Failed" : "Lỗi"}: ${clip(String(s.error), 400)}` : clip(stepSummaryText(s.type, output, en), 2000),
      lists: s.type === "task_result_report" ? [] : listsOf(output, en),
    });
  }

  const tests: RunSummary["tests"] = [];
  for (const s of steps.filter((x) => x.type === "command" && x.output)) {
    const o = s.output as Record<string, any>;
    if (o.skipped) tests.push({ step: s.key, repo: "—", passed: true, skipped: true, detail: String(o.reason ?? "") });
    for (const r of Array.isArray(o.results) ? o.results : []) {
      const pre = (r.baseline?.pre_existing ?? []).flatMap((p: any) => p.tests ?? []);
      const reg = (r.baseline?.regressions ?? []).flatMap((p: any) => p.tests ?? [p.package ?? ""]);
      const detail = [
        r.timed_out ? (en ? "timed out" : "quá thời gian") : "",
        reg.length ? `${en ? "regressions" : "lỗi mới"}: ${reg.join(", ")}` : "",
        pre.length ? `${en ? "already failing on base" : "đã lỗi sẵn trên base"}: ${pre.join(", ")}` : "",
        o.accepted_exception ? (en ? "accepted exception" : "ngoại lệ đã chấp nhận") : "",
      ].filter(Boolean).join(" · ");
      tests.push({ step: s.key, repo: String(r.repo ?? "—"), passed: !!r.passed, detail });
    }
  }

  const prs = await q(pool, "SELECT repo, url, title, source_branch, target_branch, draft FROM pull_requests WHERE run_id = $1 ORDER BY id", [runId]);

  const decisions: RunSummary["decisions"] = [];
  const stepKey = new Map(steps.map((s) => [s.id, s.key]));
  for (const qn of await q(pool, "SELECT step_id, question, answer, answered_by, answered_at FROM workflow_questions WHERE run_id = $1 AND status = 'answered' ORDER BY id", [runId]))
    decisions.push({ kind: "answer", step: stepKey.get(qn.step_id) ?? "", question: clip(qn.question, 400), answer: clip(String(qn.answer ?? ""), 600), by: qn.answered_by || null, at: qn.answered_at ? new Date(qn.answered_at).toISOString() : null });
  for (const s of steps.filter((x) => x.type === "human_approval" && x.output && x.status === "COMPLETED")) {
    const o = s.output as Record<string, any>;
    decisions.push({ kind: "approval", step: s.key, question: s.name, answer: stepSummaryText(s.type, o, en), by: o.by ?? null, at: s.finished_at ? new Date(s.finished_at).toISOString() : null });
  }

  const problems: RunSummary["problems"] = attempts
    .filter((a) => a.status === "FAILED" || (a.status === "STALE" && a.error?.interrupted))
    .map((a) => ({ step: stepKey.get(a.step_id) ?? "", attempt: a.number, status: a.status, message: clip(String(a.error?.message ?? a.error ?? ""), 400) }));

  let cost: number | null = 0, tin = 0, tout = 0, turns = 0, tools = 0;
  for (const a of attempts) {
    const m = a.metrics ?? {};
    if (typeof m.cost_usd === "number") cost = (cost ?? 0) + m.cost_usd;
    tin += Number(m.tokens?.input ?? 0) + Number(m.tokens?.cache_read ?? 0) + Number(m.tokens?.cache_creation ?? 0);
    tout += Number(m.tokens?.output ?? 0);
    turns += Number(m.turns ?? 0);
    tools += Object.values((m.tool_calls ?? {}) as Record<string, number>).reduce((n, v) => n + Number(v || 0), 0);
  }
  if (!attempts.some((a) => typeof a.metrics?.cost_usd === "number")) cost = null;
  const counted = attempts.filter((a) => a.status !== "STALE");

  const summary: RunSummary = {
    version: SUMMARY_VERSION,
    generated_at: new Date().toISOString(),
    run: {
      id: run.id,
      title: run.title,
      status: run.status,
      workflow: run.definition_key,
      agent_provider: run.agent_provider ?? "claude",
      started_at: run.started_at ? new Date(run.started_at).toISOString() : null,
      finished_at: run.finished_at ? new Date(run.finished_at).toISOString() : null,
      duration_ms: run.started_at && run.finished_at ? new Date(run.finished_at).getTime() - new Date(run.started_at).getTime() : null,
      error: run.error ?? null,
    },
    totals: {
      steps_run: stepLines.length,
      attempts: counted.length,
      // A retry is a FAILED attempt that was run again (a step resuming after a question is not a retry).
      retries: counted.filter((a) => a.status === "FAILED" && counted.some((b) => b.step_id === a.step_id && b.id > a.id)).length,
      agent_turns: turns,
      tool_calls: tools,
      cost_usd: cost == null ? null : Math.round(cost * 1000) / 1000,
      tokens_in: tin,
      tokens_out: tout,
    },
    steps: stepLines,
    changes: await changesOf(runId),
    tests,
    pull_requests: prs.map((p) => ({ repo: p.repo, url: p.url, title: p.title, source_branch: p.source_branch, target_branch: p.target_branch, draft: !!p.draft })),
    decisions,
    problems,
    markdown: "",
  };
  summary.markdown = renderRunSummaryMarkdown(summary, en);
  return summary;
}

const dur = (ms: number | null) => {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
};

/** Plain Markdown version (for copying into Hasaki Work, Jira or a PR description). */
export function renderRunSummaryMarkdown(s: RunSummary, en: boolean): string {
  const L = (vi: string, e: string) => (en ? e : vi);
  const out: string[] = [];
  out.push(`## ${L("Tóm tắt run", "Run summary")} #${s.run.id} — ${s.run.title}`);
  out.push(`${L("Trạng thái", "Status")}: **${s.run.status}** · ${L("Workflow", "Workflow")}: ${s.run.workflow} · ${L("Thời gian", "Duration")}: ${dur(s.run.duration_ms)} · ${s.totals.steps_run} ${L("bước", "steps")}, ${s.totals.attempts} ${L("lần chạy", "attempts")}${s.totals.retries ? ` (${s.totals.retries} ${L("lần thử lại", "retries")})` : ""}${s.totals.cost_usd != null ? ` · $${s.totals.cost_usd}` : ""}`);
  if (s.run.error) out.push(`\n> ${L("Lỗi", "Error")}: ${s.run.error}`);
  out.push(`\n### ${L("Đã làm gì", "What was done")}`);
  for (const st of s.steps) {
    out.push(`\n**${st.name}** (\`${st.key}\`) — ${st.status}${st.attempts > 1 ? `, ${st.attempts} ${L("lần", "attempts")}` : ""}, ${dur(st.duration_ms)}`);
    if (st.summary) out.push(st.summary);
    for (const l of st.lists) out.push(`- _${l.label}:_\n${l.items.map((i) => `  - ${i}`).join("\n")}`);
  }
  if (s.changes.length) {
    out.push(`\n### ${L("Thay đổi code", "Code changes")}`);
    for (const c of s.changes) {
      out.push(`\n**${c.repo}** · \`${c.branch}\` · +${c.additions} −${c.deletions} · ${c.files.length} file${c.note ? ` · _${c.note}_` : ""}`);
      for (const cm of c.commits) out.push(`- \`${cm.hash}\` ${cm.subject}`);
      for (const f of c.files.slice(0, 40)) out.push(`  - ${f.path} (+${f.additions ?? "bin"} −${f.deletions ?? "bin"})`);
      if (c.files.length > 40) out.push(`  - … ${c.files.length - 40} ${L("file khác", "more files")}`);
    }
  }
  if (s.tests.length) {
    out.push(`\n### ${L("Kiểm thử", "Tests")}`);
    for (const t of s.tests) out.push(`- ${t.skipped ? "⏭" : t.passed ? "✅" : "❌"} ${t.repo}${t.detail ? ` — ${t.detail}` : ""}`);
  }
  if (s.pull_requests.length) {
    out.push(`\n### Pull requests`);
    for (const p of s.pull_requests) out.push(`- [${p.repo}] [${p.title}](${p.url}) — \`${p.source_branch}\` → \`${p.target_branch}\`${p.draft ? " (draft)" : ""}`);
  }
  if (s.decisions.length) {
    out.push(`\n### ${L("Quyết định của người dùng", "Human decisions")}`);
    for (const d of s.decisions) out.push(`- ${d.kind === "answer" ? `❓ ${d.question}\n  → ${d.answer}` : `✋ ${d.question}: ${d.answer}`}`);
  }
  if (s.problems.length) {
    out.push(`\n### ${L("Sự cố trong lúc chạy", "Problems during the run")}`);
    for (const p of s.problems) out.push(`- ${p.step} #${p.attempt} (${p.status}): ${p.message}`);
  }
  return out.join("\n");
}

/** Build and store the snapshot on the run (called when the run finishes; failures are logged, never thrown). */
export async function storeRunSummary(runId: number) {
  try {
    const s = await buildRunSummary(runId);
    await q(pool, "UPDATE workflow_runs SET summary = $2 WHERE id = $1", [runId, json(s)]);
    return s;
  } catch (e) {
    console.error(`run ${runId} summary: ${(e as Error).message}`);
    return null;
  }
}

/** Stored snapshot of a finished run, or a live build (running runs, old runs, or `refresh`). */
export async function getRunSummary(runId: number, refresh = false): Promise<RunSummary> {
  const row = await one<{ status: string; summary: RunSummary | null }>(pool, "SELECT status, summary FROM workflow_runs WHERE id = $1", [runId]);
  if (!row) throw Object.assign(new Error(`run ${runId} not found`), { status: 404 });
  const finished = ["COMPLETED", "FAILED", "CANCELED"].includes(row.status);
  if (!refresh && row.summary?.version === SUMMARY_VERSION && row.summary.run.status === row.status) return row.summary;
  if (finished) return (await storeRunSummary(runId)) ?? buildRunSummary(runId);
  return buildRunSummary(runId);
}
