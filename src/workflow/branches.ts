/**
 * Existing-branch directives: "làm tiếp từ branch HSK-QA679L33 ở oms-background" means the run must commit on that
 * branch in that repository instead of cutting a new `<work item code>` branch from the base.
 *
 * Sources (first wins): explicit `run.inputs.branches` ({ repo | "*": branch }) or a directive detected in the work
 * item text. Detection is deliberately conservative: it needs a continue/reuse intent and a "branch <name>" mention in
 * the same sentence; the repository is the registered repo named in that sentence (else "*" = every repository).
 * Whether the branch really exists is checked when the worktree is prepared — a named branch is never created.
 */

const INTENT = /(làm tiếp|tiếp tục|dùng lại|không\s+(checkout|tạo|cắt)[^.\n]*branch\s+mới|continue|keep working|reuse|work on (the )?existing|based on (the )?existing)/i;
const BRANCH = /\b(?:branch|nhánh)\s+[`'"“]?([A-Za-z0-9][A-Za-z0-9._\/-]{2,80})/gi;

export type BranchMap = Record<string, string>;

export function detectBranchDirectives(text: string, repoNames: string[], baseBranch: string): BranchMap {
  const out: BranchMap = {};
  for (const sentence of text.split(/[\n.!?;]+/)) {
    if (!INTENT.test(sentence)) continue;
    const names = [...sentence.matchAll(BRANCH)].map((m) => m[1].replace(/[`'"”,)]+$/, "")).filter((b) => b !== baseBranch && !/^(mới|new|khác)$/i.test(b));
    if (!names.length) continue;
    const repos = repoNames.filter((r) => new RegExp(`(^|[^\\w-])${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`, "i").test(sentence));
    for (const repo of repos.length ? repos : ["*"]) if (!out[repo]) out[repo] = names[0];
  }
  return out;
}

/** Validates an explicit `inputs.branches` value. */
export function normalizeBranchMap(v: unknown, baseBranch: string): BranchMap | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: BranchMap = {};
  for (const [repo, b] of Object.entries(v as Record<string, unknown>)) {
    const name = String(b ?? "").trim();
    if (!name) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,200}$/.test(name) || name.includes("..")) throw new Error(`invalid branch name for ${repo}: ${name}`);
    if (name === baseBranch) throw new Error(`${repo}: cannot work directly on the base branch ${baseBranch}`);
    out[repo] = name;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Branch to use for `repo` in a run: per-repo override, then "*", then `inputs.branch` (the branch a code review run
 * reviewed — its fixes are committed on top of it), then the run's own branch.
 */
export function branchFor(run: { branch: string; inputs?: Record<string, any> | null }, repo: string): { branch: string; existing: boolean } {
  const m = (run.inputs?.branches ?? null) as BranchMap | null;
  const reviewed = typeof run.inputs?.branch === "string" && run.inputs.branch.trim() ? run.inputs.branch.trim() : undefined;
  const b = m?.[repo] ?? m?.["*"] ?? reviewed;
  return b ? { branch: b, existing: true } : { branch: run.branch, existing: false };
}
