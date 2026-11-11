/**
 * Hasaki Work `task_ai.ai_suggest` → normalized reporting specification (pure).
 * `report` is the primary spec: { "<section name>": ["<requested evidence>", ...] }. `reasoning` is context only;
 * `task_readiness` is ignored on purpose (never blocks execution).
 */

export type EvidenceKind =
  | "screenshot"
  | "attachment"
  | "note"
  | "log"
  | "test_result"
  | "commit"
  | "file_change"
  | "pr"
  | "review"
  | "implementation_summary"
  | "analysis"
  | "human_decision"
  | "task_attachment";

export interface Requirement {
  id: string; // stable: "S1.R2"
  section: string;
  text: string;
  /** What kind of proof satisfies it (derived deterministically from the wording). */
  needs: {
    screenshot: boolean;
    screenshotOnly: boolean;
    log: boolean;
    code: boolean;
    test: boolean;
    outcome: boolean;
  };
  accepts: EvidenceKind[];
}

export interface ReportSpec {
  suggest_id: string | null;
  object: string | null;
  object_value: string | null;
  has_report_constraints: boolean;
  reasoning: string | null;
  language: "vi" | "en";
  sections: Array<{ name: string; requirements: Requirement[] }>;
}

const VI = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;
const SCREENSHOT =
  /(ảnh|hình)\s*(chụp|màn hình)|chụp\s*(màn hình|ảnh)|screenshot|screen\s*shot|\bảnh\b|image|hình ảnh/i;
const LOG = /\blogs?\b|nhật ký/i;
const CODE = /\bcode\b|mã nguồn|commit|\bdiff\b|pull request|\bpr\b|merge/i;
const TEST = /\btests?\b|kiểm (tra|thử)|unit test|testing/i;
// "the order shows X after the fix", "kết quả" — a business outcome, not just a code change.
const OUTCOME =
  /sau khi (fix|sửa)|hiển thị|kết quả|thành công|hoạt động|after the fix|shows?|displays?|works?/i;
const ALTERNATIVE = /\bhoặc\b|\bor\b|\//i;

export function analyzeRequirement(
  text: string,
): Requirement["needs"] & { accepts: EvidenceKind[] } {
  const screenshot = SCREENSHOT.test(text);
  const log = LOG.test(text);
  const code = CODE.test(text);
  const test = TEST.test(text);
  const outcome = OUTCOME.test(text) && !code;
  const screenshotOnly = screenshot && !((log || code) && ALTERNATIVE.test(text));
  const accepts = new Set<EvidenceKind>(["note"]);
  if (screenshot) accepts.add("screenshot").add("attachment");
  if (!screenshotOnly) {
    if (log) accepts.add("log").add("test_result");
    if (code)
      accepts
        .add("commit")
        .add("file_change")
        .add("pr")
        .add("implementation_summary")
        .add("review");
    if (test) accepts.add("test_result").add("log");
    if (!screenshot && !log && !code && !test)
      for (const k of [
        "implementation_summary",
        "test_result",
        "commit",
        "file_change",
        "review",
        "log",
      ] as const)
        accepts.add(k);
  }
  return { screenshot, screenshotOnly, log, code, test, outcome, accepts: [...accepts] };
}

/** null when there is nothing meaningful to report (missing/null ai_suggest, empty report, only blank items). */
export function parseAiSuggest(payload: any): ReportSpec | null {
  const ai = payload?.task_ai?.ai_suggest ?? payload?.data?.task_ai?.ai_suggest;
  if (
    !ai ||
    typeof ai !== "object" ||
    !ai.report ||
    typeof ai.report !== "object" ||
    Array.isArray(ai.report)
  )
    return null;
  const sections: ReportSpec["sections"] = [];
  for (const [name, raw] of Object.entries<any>(ai.report)) {
    const items = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [])
      .map((x) => (typeof x === "string" ? x.trim() : ""))
      .filter(Boolean);
    if (!name.trim() || !items.length) continue;
    const si = sections.length + 1;
    sections.push({
      name: name.trim(),
      requirements: items.map((text, i) => {
        const { accepts, ...needs } = analyzeRequirement(text);
        return { id: `S${si}.R${i + 1}`, section: name.trim(), text, needs, accepts };
      }),
    });
  }
  if (!sections.length) return null;
  const sample = [
    ...sections.map((s) => s.name),
    ...sections.flatMap((s) => s.requirements.map((r) => r.text)),
    ai.reasoning ?? "",
  ].join(" ");
  return {
    suggest_id: ai.suggest_id ?? null,
    object: ai.object ?? null,
    object_value: ai.object_value != null ? String(ai.object_value) : null,
    has_report_constraints: ai.has_report_constraints === true,
    reasoning: typeof ai.reasoning === "string" ? ai.reasoning : null,
    language: VI.test(sample) ? "vi" : "en",
    sections,
  };
}
