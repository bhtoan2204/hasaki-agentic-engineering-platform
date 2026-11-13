import { createHash } from "node:crypto";
import { isCodebaseMap, isRestricted, type Applicability } from "./resolve.ts";
import { MAX_CHARS } from "./importer.ts";
import { duplicateCoverage, isLive } from "./proposals.ts";

export interface AuditItem {
  id?: number;
  key: string;
  title: string;
  category: string;
  scope_type: string;
  scope_ref?: string;
  owner_id?: number | null;
  content: string;
  applicability?: Applicability;
  metadata?: Record<string, unknown>;
  enabled?: boolean;
  enforced?: boolean;
  conflict_key?: string | null;
  superseded_by?: number | string | null;
  expires_at?: string | Date | null;
  effective_from?: string | Date | null;
  current_version?: number;
}
export interface AuditUsage {
  selected: number;
  packs: number;
  loaded: number;
  truncated: number;
}
export interface AuditInput {
  items: AuditItem[];
  steps: Array<{ key: string; type: string }>;
  usage?: Record<string, AuditUsage>;
  totalPacks?: number;
  repositories?: string[];
  now?: Date;
  windowDays?: number;
  maxTokens?: number;
  providerAvailability?: Record<string, boolean>;
  missingPaths?: Record<string, string[]>;
  nativeSources?: Array<{ repo: string; path: string; sha256: string }>;
  roleFootprint?: Record<string, { packs: number; tokens: number }>;
}
export interface AuditFinding {
  kind: string;
  keys: string[];
  classification: "verified" | "suspected" | "needs human approval";
  action: string;
  autoApply: boolean;
  detail: string;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/);
export function textSimilarity(a: string, b: string): number {
  const shingles = (s: string) => {
    const w = words(s);
    return new Set(w.map((_, i) => w.slice(i, i + 3).join(" ")));
  };
  const x = shingles(a),
    y = shingles(b);
  const intersection = [...x].filter((w) => y.has(w)).length;
  return intersection / (new Set([...x, ...y]).size || 1);
}

export function highImpact(
  item: AuditItem,
  usage: AuditUsage | undefined,
  totalPacks: number,
): boolean {
  return (
    !!item.enforced ||
    ["security_policy", "business_rule"].includes(item.category) ||
    (totalPacks > 0 && (usage?.packs ?? 0) / totalPacks > 0.1)
  );
}
export function auditKnowledge(input: AuditInput) {
  const now = input.now ?? new Date();
  const findings: AuditFinding[] = [];
  const items = input.items
    .filter((i) => i.enabled !== false)
    .sort(
      (a, b) =>
        (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER) ||
        a.key.localeCompare(b.key),
    );
  const add = (
    kind: string,
    rows: AuditItem[],
    classification: AuditFinding["classification"],
    action: string,
    detail: string,
  ) => {
    const safe =
      kind === "exact_duplicate" &&
      duplicateCoverage(rows) &&
      !rows[0].superseded_by &&
      isLive(rows[0], now) &&
      rows.every(
        (r) => r.owner_id == null && !highImpact(r, input.usage?.[r.key], input.totalPacks ?? 0),
      );
    findings.push({
      kind,
      keys: rows.map((r) => r.key),
      classification: safe
        ? classification
        : classification === "verified" && kind === "exact_duplicate"
          ? "needs human approval"
          : classification,
      action,
      autoApply: safe,
      detail,
    });
  };
  const hashes = new Map(items.map((i) => [i, hash(i.content)]));
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    for (const b of items.slice(i + 1)) {
      if ((a.owner_id ?? null) !== (b.owner_id ?? null)) continue;
      if (hashes.get(a) === hashes.get(b))
        add(
          "exact_duplicate",
          [a, b].sort((x, y) => (x.id ?? 0) - (y.id ?? 0) || x.key.localeCompare(y.key)),
          "verified",
          "Keep the older canonical item; deprecate the duplicate through a proposal",
          "Identical SHA-256 content",
        );
      else if (textSimilarity(a.content, b.content) >= 0.8)
        add(
          "near_duplicate",
          [a, b],
          "suspected",
          "Review consolidation proposal",
          "Normalized shingled Jaccard >= 0.8",
        );
      const sameSteps = a.applicability?.step_keys?.some((s) =>
        b.applicability?.step_keys?.includes(s),
      );
      if (
        a.category === b.category &&
        sameSteps &&
        textSimilarity(
          String(a.metadata?.description ?? a.title),
          String(b.metadata?.description ?? b.title),
        ) >= 0.8
      )
        add(
          "responsibility_overlap",
          [a, b],
          "suspected",
          "Review responsibility consolidation",
          "Same category and agent targets with similar descriptions",
        );
      const contradiction = (x: string, y: string) =>
        (/\btest[- ]first\b/i.test(x) && /\btest[- ]after\b/i.test(y)) ||
        (/no comments|never.*comments/i.test(x) && /always.*comments|shortcut:/i.test(y));
      if (
        (a.conflict_key && a.conflict_key === b.conflict_key) ||
        contradiction(a.content, b.content) ||
        contradiction(b.content, a.content)
      )
        add(
          "conflict",
          [a, b],
          "needs human approval",
          "Review conflicting shared guidance; retain pending proposal",
          a.conflict_key === b.conflict_key ? "Shared conflict key" : "Curated contradiction rule",
        );
    }
    if (a.superseded_by || (a.expires_at && new Date(a.expires_at) <= now))
      add(
        "outdated",
        [a],
        "verified",
        "Review deprecation proposal",
        "Enabled but superseded or expired",
      );
    if (a.content.length === MAX_CHARS)
      add(
        "truncated_import",
        [a],
        "suspected",
        "Review original source before restoring",
        "Content equals the import cap",
      );
    if (input.repositories && a.applicability?.repos?.some((r) => !input.repositories!.includes(r)))
      add(
        "missing_repository",
        [a],
        "suspected",
        "Review repository references",
        "Applicability references an unregistered repository",
      );
    const targets = a.applicability?.step_keys;
    const types = a.applicability?.step_types;
    const reaches = (key?: string) =>
      input.steps.some(
        (s) =>
          ["agent", "coding_agent"].includes(s.type) &&
          (key === undefined || s.key === key) &&
          (!types?.length || types.includes(s.type)),
      );
    const deadKeys = targets?.length ? targets.filter((k) => !reaches(k)) : [];
    if (deadKeys.length || (types?.length && !reaches()))
      add(
        "unreachable",
        [a],
        "verified",
        "Review applicability proposal",
        deadKeys.length
          ? `Step keys with no matching agent step (command steps cannot load skills): ${deadKeys.join(", ")}`
          : "No matching agent step; command steps cannot load skills",
      );
    if (
      a.category === "agent_skill" &&
      a.scope_type === "GLOBAL" &&
      !isRestricted(a.applicability ?? {})
    )
      add(
        "unrestricted_global",
        [a],
        "verified",
        "Assign explicitly or restrict applicability",
        "GLOBAL skills without restrictions are opt-in only",
      );
    if (a.category === "agent_skill" && input.providerAvailability?.[a.key] === false)
      add(
        "provider_unavailable",
        [a],
        "verified",
        "Review provider availability",
        "Unavailable on all four providers",
      );
    if (input.missingPaths?.[a.key]?.length)
      add(
        "missing_path",
        [a],
        "verified",
        "Review missing repository source paths",
        input.missingPaths[a.key].join(", "),
      );
    if (
      input.nativeSources?.some(
        (n) =>
          n.sha256 === hash(a.content) ||
          (Array.isArray(a.metadata?.source) &&
            a.metadata.source.some(
              (s: { repo?: string; path?: string; sha256?: string }) =>
                s.repo === n.repo && s.path === n.path && s.sha256 === n.sha256,
            )),
      )
    )
      add(
        "native_duplicate_source",
        [a],
        "verified",
        "Review pending suppression proposal; do not change native files automatically",
        "Native AGENTS.md or .cursor/rules matches registry SHA-256",
      );
    if (isCodebaseMap(a))
      add(
        "codebase_map_consolidation",
        [a],
        "needs human approval",
        "Review replacement by bounded code-intelligence map on Ponytail pilot",
        "Avoid multiple map sources on pilot steps",
      );
    const u = input.usage?.[a.key];
    if (Math.ceil(a.content.length / 4) > (input.maxTokens ?? 8000))
      add(
        "excessive_context",
        [a],
        "verified",
        "Review splitting or on-demand disclosure",
        `${Math.ceil(a.content.length / 4)} estimated tokens`,
      );
    if (u?.truncated)
      add(
        "repeated_truncation",
        [a],
        "verified",
        "Review splitting proposal",
        `${u.truncated} truncated packs`,
      );
    if (input.usage && !(u?.selected || u?.packs || u?.loaded))
      add(
        "unused",
        [a],
        "suspected",
        "Review usage and reachability; never disable from absence alone",
        "No usage evidence in the audit window",
      );
  }
  const conflicting = new Set(findings.filter((f) => f.kind === "conflict").flatMap((f) => f.keys));
  for (const f of findings)
    if (f.autoApply && f.keys.some((k) => conflicting.has(k))) {
      f.autoApply = false;
      f.classification = "needs human approval";
    }
  const counts = (field: "category" | "scope_type") =>
    Object.fromEntries(
      [...new Set(input.items.map((i) => i[field]))]
        .sort()
        .map((v) => [v, input.items.filter((i) => i[field] === v).length]),
    );
  return {
    generatedAt: now.toISOString(),
    windowDays: input.windowDays ?? 7,
    itemCount: input.items.length,
    roleFootprint: input.roleFootprint ?? {},
    findingCounts: Object.fromEntries(
      [...new Set(findings.map((f) => f.kind))]
        .sort()
        .map((kind) => [kind, findings.filter((f) => f.kind === kind).length]),
    ),
    counts: {
      category: counts("category"),
      scope: counts("scope_type"),
      ownership: {
        shared: input.items.filter((i) => i.owner_id == null).length,
        private: input.items.filter((i) => i.owner_id != null).length,
      },
    },
    findings,
  };
}
export type KnowledgeAudit = ReturnType<typeof auditKnowledge>;
export function auditMarkdown(report: KnowledgeAudit): string {
  return `# Knowledge audit\n\nGenerated: ${report.generatedAt}. Window: ${report.windowDays} days. Items: ${report.itemCount}.\n\nPrivate findings are aggregate counts only.\n\n${JSON.stringify(report.counts, null, 2)}\n\n| Finding | Classification | Items | Proposed action |\n|---|---|---|---|\n${report.findings.map((f) => `| ${f.kind} | ${f.classification} | ${f.keys.join(", ")} | ${f.action} |`).join("\n")}\n`;
}
