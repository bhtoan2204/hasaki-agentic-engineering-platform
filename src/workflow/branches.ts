/**
 * Existing-branch directives: "làm tiếp từ branch HSK-QA679L33 ở oms-background" means the run must commit on that
 * branch in that repository instead of cutting a new `<work item code>` branch from the base.
 *
 * Sources (first wins): explicit `run.inputs.branches` ({ repo | "*": branch }) or a directive detected in the work
 * item text. Detection is deliberately conservative: it needs a continue/reuse intent and a "branch <name>" mention in
 * the same sentence; the repository is the registered repo named in that sentence (else "*" = every repository).
 * Whether the branch really exists is checked when the worktree is prepared — a named branch is never created.
 */

const INTENT =
  /(làm tiếp|tiếp tục|dùng lại|không\s+(checkout|tạo|cắt)[^.\n]*branch\s+mới|continue|keep working|reuse|work on (the )?existing|based on (the )?existing)/i;
const KEYWORD = /\b(?:branch|nhánh)\b/gi;
/** Words that follow "branch" in prose but are never the branch itself. */
const FILLER =
  /^(task|cha|con|của|gốc|mẹ|parent|child|base|the|this|that|current|hiện|tại|này|đó|từ|from|of|là|tên|name|named|existing|có|sẵn)$/i;
const BRANCH_LIKE = /[\/_-]|\d/;

export type BranchMap = Record<string, string>;

export function detectBranchDirectives(
  text: string,
  repoNames: string[],
  baseBranch: string,
): BranchMap {
  const out: BranchMap = {};
  for (const sentence of text.split(/[\n.!?;]+/)) {
    if (!INTENT.test(sentence)) continue;
    // Look at up to four words after "branch"/"nhánh" ("branch task cha: HSK-1", "nhánh của task HSK-1"): the first
    // one that is quoted or looks like a branch name (separator or digit) wins; filler words are skipped.
    const names = [...sentence.matchAll(KEYWORD)]
      .flatMap((m) => {
        const words = sentence
          .slice(m.index! + m[0].length)
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 4);
        for (const raw of words) {
          const quoted = /^[`'"“]/.test(raw);
          const w = raw.replace(/^[`'"“]+|[`'"”,:;.)]+$/g, "");
          if (!w || FILLER.test(w)) continue;
          if (/^[A-Za-z0-9][A-Za-z0-9._\/-]{2,80}$/.test(w) && (quoted || BRANCH_LIKE.test(w)))
            return [w];
        }
        return [];
      })
      .filter((b) => b !== baseBranch && !/^(mới|new|khác)$/i.test(b));
    if (!names.length) continue;
    const repos = repoNames.filter((r) =>
      new RegExp(`(^|[^\\w-])${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`, "i").test(
        sentence,
      ),
    );
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
    if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,200}$/.test(name) || name.includes(".."))
      throw new Error(`invalid branch name for ${repo}: ${name}`);
    if (name === baseBranch)
      throw new Error(`${repo}: cannot work directly on the base branch ${baseBranch}`);
    out[repo] = name;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Branch to use for `repo` in a run: per-repo override, then "*", then `inputs.branch` (the branch a code review run
 * reviewed — its fixes are committed on top of it), then the run's own branch.
 */
export function branchFor(
  run: { branch: string; inputs?: Record<string, any> | null },
  repo: string,
): { branch: string; existing: boolean } {
  const m = (run.inputs?.branches ?? null) as BranchMap | null;
  const reviewed =
    typeof run.inputs?.branch === "string" && run.inputs.branch.trim()
      ? run.inputs.branch.trim()
      : undefined;
  const b = m?.[repo] ?? m?.["*"] ?? reviewed;
  return b ? { branch: b, existing: true } : { branch: run.branch, existing: false };
}
