/**
 * Deterministic knowledge resolution (pure; no I/O).
 *
 * Precedence (most specific wins): GLOBAL < ORGANIZATION < PROJECT < REPOSITORY < WORKFLOW < STEP.
 * Items compete only when they share a `conflict_key`. Within a conflict group the winner is chosen by:
 *   1. enforced items beat non-enforced ones (security policies cannot be overridden by narrower scopes);
 *      among enforced items the BROADEST scope wins (an organisation-wide policy outranks a project one);
 *   2. otherwise the most specific scope;
 *   3. then higher `priority`, then higher version, then key (stable tiebreak).
 */

export const SCOPES = ["GLOBAL", "ORGANIZATION", "PROJECT", "REPOSITORY", "WORKFLOW", "STEP"] as const;
export type Scope = (typeof SCOPES)[number];
export const CATEGORIES = [
  "business_rule",
  "architecture_guideline",
  "coding_standard",
  "domain_knowledge",
  "security_policy",
  "agent_skill",
  "repository_convention",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Applicability {
  step_types?: string[];
  step_keys?: string[];
  repos?: string[];
  projects?: string[];
  workflows?: string[];
  /** Any keyword found in the request text makes the item applicable (case-insensitive). */
  keywords?: string[];
}

export interface KnowledgeCandidate {
  key: string;
  title: string;
  category: Category;
  scope_type: Scope;
  scope_ref: string;
  conflict_key: string | null;
  priority: number;
  enforced: boolean;
  version: number;
  content: string;
  applicability: Applicability;
  metadata: Record<string, unknown>;
}

export interface ResolutionContext {
  organization: string;
  project: string;
  repositories: string[];
  workflowKey: string;
  stepKey: string;
  stepType: string;
  text: string;
  /** Keys assigned explicitly in the step config (`skills`, `knowledge`): always included if enabled. */
  explicit: string[];
}

export interface Resolution {
  applied: Array<KnowledgeCandidate & { reason: string }>;
  overridden: Array<{ key: string; version: number; by: string; conflict_key: string }>;
}

const eqi = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const anyEq = (list: string[], v: string) => list.some((x) => eqi(x, v));

export function scopeMatches(c: Pick<KnowledgeCandidate, "scope_type" | "scope_ref">, ctx: ResolutionContext): boolean {
  switch (c.scope_type) {
    case "GLOBAL":
      return true;
    case "ORGANIZATION":
      return eqi(c.scope_ref, ctx.organization);
    case "PROJECT":
      return !!ctx.project && eqi(c.scope_ref, ctx.project);
    case "REPOSITORY":
      return anyEq(ctx.repositories, c.scope_ref);
    case "WORKFLOW":
      return eqi(c.scope_ref, ctx.workflowKey);
    case "STEP":
      // "workflow:step" or a bare step key (applies to that step key in any workflow)
      return eqi(c.scope_ref, `${ctx.workflowKey}:${ctx.stepKey}`) || eqi(c.scope_ref, ctx.stepKey);
  }
}

export function applicabilityMatches(a: Applicability, ctx: ResolutionContext): boolean {
  if (a.step_types?.length && !anyEq(a.step_types, ctx.stepType)) return false;
  if (a.step_keys?.length && !anyEq(a.step_keys, ctx.stepKey)) return false;
  if (a.workflows?.length && !anyEq(a.workflows, ctx.workflowKey)) return false;
  if (a.projects?.length && !anyEq(a.projects, ctx.project)) return false;
  if (a.repos?.length && !a.repos.some((r) => anyEq(ctx.repositories, r))) return false;
  if (a.keywords?.length) {
    const text = ctx.text.toLowerCase();
    if (!a.keywords.some((k) => text.includes(k.toLowerCase()))) return false;
  }
  return true;
}

const rank = (s: Scope) => SCOPES.indexOf(s);

const RESTRICTING = ["repos", "projects", "workflows", "step_keys", "step_types"] as const;
const isRestricted = (a: Applicability) => RESTRICTING.some((k) => (a[k]?.length ?? 0) > 0);
const describeRestriction = (a: Applicability) => RESTRICTING.filter((k) => a[k]?.length).map((k) => `${k} ${a[k]!.join(", ")}`).join("; ");

/** Total order: negative when `a` beats `b`. */
export function compareCandidates(a: KnowledgeCandidate, b: KnowledgeCandidate): number {
  if (a.enforced !== b.enforced) return a.enforced ? -1 : 1;
  if (rank(a.scope_type) !== rank(b.scope_type))
    return a.enforced ? rank(a.scope_type) - rank(b.scope_type) : rank(b.scope_type) - rank(a.scope_type);
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.version !== b.version) return b.version - a.version;
  return a.key.localeCompare(b.key);
}

export function resolveKnowledge(candidates: KnowledgeCandidate[], ctx: ResolutionContext): Resolution {
  const eligible: Array<KnowledgeCandidate & { reason: string }> = [];
  for (const c of candidates) {
    if (ctx.explicit.includes(c.key)) eligible.push({ ...c, reason: "assigned to step" });
    else if (c.category !== "agent_skill" && scopeMatches(c, ctx) && applicabilityMatches(c.applicability, ctx))
      eligible.push({ ...c, reason: `${c.scope_type}${c.scope_ref ? ":" + c.scope_ref : ""} scope` });
    else if (c.category === "agent_skill" && scopeMatches(c, ctx) && (c.scope_type !== "GLOBAL" || isRestricted(c.applicability)) && applicabilityMatches(c.applicability, ctx))
      // Skills are opt-in: explicitly assigned, scoped narrower than GLOBAL, or restricted by applicability (repos, projects...).
      eligible.push({ ...c, reason: c.scope_type !== "GLOBAL" ? `skill scoped to ${c.scope_type}:${c.scope_ref}` : `skill for ${describeRestriction(c.applicability)}` });
  }
  const applied: Resolution["applied"] = [];
  const overridden: Resolution["overridden"] = [];
  const groups = new Map<string, typeof eligible>();
  for (const c of eligible) {
    if (!c.conflict_key) applied.push(c);
    else (groups.get(c.conflict_key) ?? groups.set(c.conflict_key, []).get(c.conflict_key)!).push(c);
  }
  for (const [ck, group] of groups) {
    group.sort(compareCandidates);
    applied.push(group[0]);
    for (const loser of group.slice(1)) overridden.push({ key: loser.key, version: loser.version, by: group[0].key, conflict_key: ck });
  }
  // Stable presentation order: category, then scope (broad first), then key.
  applied.sort((a, b) => a.category.localeCompare(b.category) || rank(a.scope_type) - rank(b.scope_type) || a.key.localeCompare(b.key));
  return { applied, overridden };
}
