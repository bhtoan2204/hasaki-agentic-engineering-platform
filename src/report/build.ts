import type { Evidence } from "./evidence.ts";
import type { Requirement, ReportSpec } from "./aiSuggest.ts";

/**
 * Report assembly with deterministic validation (pure). An optional reasoner (Claude) proposes, per requirement, a
 * status, the evidence ids it relies on and an explanation. Rules then cap that proposal:
 *   - cited ids must exist and be of a kind that can satisfy the requirement (fabricated/irrelevant ids are dropped);
 *   - a screenshot-only requirement is MISSING without an image (uploaded or attached) — code is not a screenshot;
 *   - an outcome requirement ("after the fix the order shows …") cannot be VERIFIED from code changes alone;
 *   - failed tests, stale uploads and task attachments (pre-fix) never verify anything;
 *   - without a reasoner, nothing is VERIFIED automatically except human evidence attached to that requirement.
 */

export type Status = "VERIFIED" | "PARTIAL" | "MISSING";
const RANK: Record<Status, number> = { MISSING: 0, PARTIAL: 1, VERIFIED: 2 };
const min = (a: Status, b: Status): Status => (RANK[a] <= RANK[b] ? a : b);

export interface Proposal {
  summary?: string;
  requirements?: Array<{ id: string; status: Status; evidence_ids?: string[]; explanation?: string }>;
  limitations?: string[];
}

export interface RequirementResult {
  id: string;
  text: string;
  status: Status;
  evidence: Array<{ id: string; kind: string; title: string; ref: Evidence["ref"] }>;
  explanation: string;
  rule: string;
}

export interface TaskReport {
  task: { code: string | null; title: string | null; id: number | string | null };
  object: string | null;
  object_value: string | null;
  suggest_id: string | null;
  has_report_constraints: boolean;
  language: "vi" | "en";
  reasoning: string | null;
  summary: string;
  sections: Array<{ name: string; requirements: RequirementResult[] }>;
  counts: Record<Status, number>;
  related: { commits: string[]; files: string[]; tests: string[]; pull_requests: string[] };
  limitations: string[];
  generated_by: "rules" | "rules+claude";
  generated_at: string;
}

/** The best status the evidence can justify for this requirement, and why. */
export function ruleCap(req: Requirement, usable: Evidence[]): { cap: Status; rule: string } {
  const humanForReq = usable.filter((e) => e.requirement_id === req.id && (e.kind === "screenshot" || e.kind === "attachment" || e.kind === "note"));
  if (req.needs.screenshotOnly) {
    // The model cannot see image content: only a screenshot the user attached to THIS requirement verifies it.
    const linked = usable.filter((e) => e.image && !e.stale && e.requirement_id === req.id);
    if (linked.length) return { cap: "VERIFIED", rule: "screenshot attached to this requirement" };
    if (usable.some((e) => e.image)) return { cap: "PARTIAL", rule: "a screenshot exists but is not attached to this requirement" };
    return { cap: "MISSING", rule: "screenshot requested; no screenshot available" };
  }
  if (!usable.length) return { cap: "MISSING", rule: "no supporting evidence" };
  const codeOnly = usable.every((e) => ["commit", "file_change", "implementation_summary", "pr", "analysis"].includes(e.kind));
  if (req.needs.outcome && codeOnly && !humanForReq.length) return { cap: "PARTIAL", rule: "outcome requirement: code changes alone do not verify the business result" };
  return { cap: "VERIFIED", rule: "acceptable evidence available" };
}

export function buildReport(
  spec: ReportSpec,
  evidence: Evidence[],
  proposal: Proposal | null,
  meta: { task: TaskReport["task"]; fallbackSummary: string },
): TaskReport {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const proposed = new Map((proposal?.requirements ?? []).map((r) => [r.id, r]));
  const sections = spec.sections.map((sec) => ({
    name: sec.name,
    requirements: sec.requirements.map((req): RequirementResult => {
      const acceptable = (e: Evidence) => req.accepts.includes(e.kind) && !e.before_fix && e.passed !== false && !(e.requirement_id && e.requirement_id !== req.id);
      const p = proposed.get(req.id);
      // Evidence considered: what the reasoner cited (if real and acceptable) + human evidence attached to this requirement.
      const cited = (p?.evidence_ids ?? []).map((id) => byId.get(id)).filter((e): e is Evidence => !!e && acceptable(e));
      const human = evidence.filter((e) => e.requirement_id === req.id && acceptable(e));
      const pool = proposal ? [...new Set([...cited, ...human])] : evidence.filter(acceptable);
      const usable = pool.filter((e) => !e.stale);
      const { cap, rule } = ruleCap(req, usable);
      let status: Status;
      if (proposal) status = min(p?.status ?? "MISSING", cap);
      else status = human.some((e) => !e.stale) && cap === "VERIFIED" ? "VERIFIED" : min(usable.length ? "PARTIAL" : "MISSING", cap);
      if (status === "VERIFIED" && !usable.length) status = "MISSING";
      const dropped = (p?.evidence_ids ?? []).filter((id) => !cited.some((e) => e.id === id));
      const explanation = [
        p?.explanation ?? (status === "MISSING" ? "Không tìm thấy bằng chứng phù hợp." : ""),
        status !== (p?.status ?? status) ? `(hạ từ ${p?.status} → ${status}: ${rule})` : "",
        dropped.length ? `(bỏ bằng chứng không hợp lệ/không phù hợp: ${dropped.join(", ")})` : "",
        pool.some((e) => e.stale) ? "(có bằng chứng tải lên trước lần thay đổi code mới nhất — cần xác nhận lại)" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return { id: req.id, text: req.text, status, evidence: usable.map((e) => ({ id: e.id, kind: e.kind, title: e.title, ref: e.ref })), explanation, rule };
    }),
  }));
  const all = sections.flatMap((s) => s.requirements);
  const counts = { VERIFIED: 0, PARTIAL: 0, MISSING: 0 } as Record<Status, number>;
  for (const r of all) counts[r.status]++;
  const vi = spec.language === "vi";
  const limitations = [
    ...all.filter((r) => r.status !== "VERIFIED").map((r) => `${r.id} ${r.status}: ${r.text}${r.rule ? ` — ${r.rule}` : ""}`),
    ...(proposal?.limitations ?? []),
    ...(proposal ? [] : [vi ? "Không có phân tích của Claude: trạng thái dựa hoàn toàn trên luật kiểm định." : "No Claude analysis: statuses are rule-based only."]),
  ];
  return {
    task: meta.task,
    object: spec.object,
    object_value: spec.object_value,
    suggest_id: spec.suggest_id,
    has_report_constraints: spec.has_report_constraints,
    language: spec.language,
    reasoning: spec.reasoning,
    summary: proposal?.summary?.trim() || meta.fallbackSummary,
    sections,
    counts,
    related: {
      commits: evidence.filter((e) => e.kind === "commit").map((e) => e.title),
      files: evidence.filter((e) => e.kind === "file_change").map((e) => e.title),
      tests: evidence.filter((e) => e.kind === "test_result").map((e) => e.title),
      pull_requests: evidence.filter((e) => e.kind === "pr").map((e) => `${e.title}: ${e.ref.url}`),
    },
    limitations,
    generated_by: proposal ? "rules+claude" : "rules",
    generated_at: new Date().toISOString(),
  };
}

const ICON: Record<Status, string> = { VERIFIED: "✅", PARTIAL: "🟡", MISSING: "❌" };

/** Business-facing Markdown, rendered deterministically from the JSON report (nothing is invented here). */
export function renderMarkdown(r: TaskReport, approval?: { by?: string; at?: string; comment?: string }): string {
  const vi = r.language === "vi";
  const L = vi
    ? { title: "Báo cáo kết quả task", obj: "Đối tượng", sug: "AI suggest", sum: "Tóm tắt", ev: "Bằng chứng", none: "(không có)", rel: "Liên quan", commits: "Commit", files: "File thay đổi", tests: "Kiểm thử", prs: "Pull request", lim: "Thiếu bằng chứng / giới hạn", appr: "Phê duyệt", st: { VERIFIED: "ĐÃ XÁC MINH", PARTIAL: "MỘT PHẦN", MISSING: "THIẾU" } }
    : { title: "Task result report", obj: "Object", sug: "AI suggest", sum: "Summary", ev: "Evidence", none: "(none)", rel: "Related", commits: "Commits", files: "Changed files", tests: "Tests", prs: "Pull requests", lim: "Missing evidence / limitations", appr: "Approval", st: { VERIFIED: "VERIFIED", PARTIAL: "PARTIAL", MISSING: "MISSING" } };
  const out = [
    `# ${L.title}: ${r.task.code ?? ""} ${r.task.title ?? ""}`.trim(),
    "",
    r.object ? `- **${L.obj}:** ${r.object}${r.object_value ? ` — \`${r.object_value}\`` : ""}` : "",
    r.suggest_id ? `- **${L.sug}:** \`${r.suggest_id}\`${r.has_report_constraints ? " (has report constraints)" : ""}` : "",
    `- ✅ ${r.counts.VERIFIED} · 🟡 ${r.counts.PARTIAL} · ❌ ${r.counts.MISSING}`,
    "",
    `## ${L.sum}`,
    r.summary,
    "",
  ];
  for (const s of r.sections) {
    out.push(`## ${s.name}`);
    for (const q of s.requirements) {
      out.push(`- ${ICON[q.status]} **${L.st[q.status]}** — ${q.text}`);
      if (q.evidence.length) for (const e of q.evidence) out.push(`  - ${L.ev}: ${e.title}${e.ref.url ? ` (${e.ref.url})` : ""}`);
      else out.push(`  - ${L.ev}: ${L.none}`);
      if (q.explanation) out.push(`  - ${q.explanation}`);
    }
    out.push("");
  }
  const rel = [
    [L.commits, r.related.commits],
    [L.files, r.related.files],
    [L.tests, r.related.tests],
    [L.prs, r.related.pull_requests],
  ] as const;
  if (rel.some(([, v]) => v.length)) {
    out.push(`## ${L.rel}`);
    for (const [label, v] of rel) if (v.length) out.push(`**${label}:**`, ...v.slice(0, 30).map((x) => `- ${x}`));
    out.push("");
  }
  if (r.limitations.length) out.push(`## ${L.lim}`, ...r.limitations.map((x) => `- ${x}`), "");
  if (approval) out.push(`## ${L.appr}`, `- ${approval.by || "reviewer"} · ${approval.at ?? ""}${approval.comment ? ` — ${approval.comment}` : ""}`, "");
  return out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n").trim() + "\n";
}
