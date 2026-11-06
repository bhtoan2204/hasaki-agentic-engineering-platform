import { isEvaluationRun } from "../eval/scope.ts";
import { z } from "zod";
import { config } from "../config.ts";
import { pool, q, one, json, type Db } from "../db/pool.ts";
import { hashOf } from "../workflow/definitions.ts";
import { scoreKnowledge } from "../context/plan.ts";
import { looksSecret } from "./importer.ts";
import { knowledge } from "./service.ts";
import { SCOPES, type KnowledgeCandidate } from "./resolve.ts";
import { createProposal, getProposal, termChange, type ChangeType, type Evidence, type ProposalInput, EVOLVABLE, CHANGE_TYPES } from "./proposals.ts";

/**
 * Continuous learning: turn what humans decided during a workflow into reviewable knowledge-change proposals, and turn
 * approved rule changes into reviewable skill updates. Nothing here writes authoritative knowledge — proposals.ts does,
 * and only on human approval.
 *
 * Trusted inputs (and only these are analysed):
 *   - answers to the agent's questions (workflow_questions, answered by an authenticated user)
 *   - approval / rejection comments of human steps (workflow_steps.approval)
 *   - re-execution instructions given by a user (attempt input.pending.reexecute)
 *   - the work item text (the BA ticket) — trust "requirement": a proposal resting on it alone is marked less certain
 * Agent output, repository text and tool results are never sources: the analyzer does not see them.
 *
 * The semantic step (does this input change an existing rule?) is one tool-less completion through the run's provider,
 * registered by the worker (setKnowledgeChangeAnalyzer). Everything around it is deterministic: source collection,
 * the "is there anything to analyse" gate, quote verification (every evidence quote must appear verbatim in the cited
 * source), target/scope validation, impact analysis, dedupe and idempotence (a run whose inputs did not change is not
 * analysed twice).
 */

export interface HumanSource {
  id: string;
  source: Evidence["source"];
  trust: "human" | "requirement";
  author: string;
  text: string;
  ref: Record<string, unknown>;
}

export interface AnalyzerInput {
  run: { id: number; title: string; project: string; workflow: string; repositories: string[] };
  sources: HumanSource[];
  rules: Array<{ key: string; version: number; title: string; category: string; scope: string; content: string }>;
  skills: Array<{ key: string; title: string; description: string }>;
}
export type ChangeAnalyzer = (input: AnalyzerInput, run: { agent_provider?: string | null }) => Promise<unknown>;
export interface SkillDraftInput {
  skill: { key: string; title: string; content: string };
  oldRule: string;
  newRule: string;
  changeType: ChangeType;
  scope: string;
}
export type SkillDrafter = (x: SkillDraftInput, run: { agent_provider?: string | null } | null) => Promise<{ content: string; summary?: string }>;

let analyzer: ChangeAnalyzer | null = null;
let drafter: SkillDrafter | null = null;
/** The worker registers the model-backed implementations (agent/learningModel.ts); tests inject fakes. */
export function setKnowledgeChangeAnalyzer(fn: ChangeAnalyzer | null) {
  analyzer = fn;
}
export function setSkillDrafter(fn: SkillDrafter | null) {
  drafter = fn;
}

const clean = (s: unknown, max: number) => String(s ?? "").replace(/<\/?untrusted_input[^>]*>/gi, "").slice(0, max).trim();
const norm = (s: string) => String(s ?? "").toLowerCase().normalize("NFKC").replace(/[\s"'`“”‘’]+/g, " ").trim();

/** Wording that announces a rule change in a requirement ("thay vì", "from now on", "no longer" …). */
export const CHANGE_SIGNAL = /\b(instead of|no longer|from now on|must now|changed? (to|from)|replace[sd]?|supersede[sd]?|deprecate[sd]?|effective (from|on|date))\b|thay vì|thay cho|không còn|từ nay|chuyển sang|đổi (thành|sang|từ)|thay đổi (rule|quy tắc|cách tính|logic)|áp dụng từ|hiệu lực từ|BA (xác nhận|confirm)/i;

// ---------------------------------------------------------------- sources

export async function collectHumanSources(runId: number, db: Db = pool): Promise<HumanSource[]> {
  const out: HumanSource[] = [];
  const seen = new Set<string>();
  const push = (s: HumanSource) => {
    const k = norm(s.text);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };
  for (const x of await q(db, "SELECT q.id, q.question, q.answer, q.answered_by, s.key FROM workflow_questions q JOIN workflow_steps s ON s.id = q.step_id WHERE q.run_id = $1 AND q.status = 'answered' ORDER BY q.id", [runId]))
    push({ id: `answer:${x.id}`, source: "answer", trust: "human", author: x.answered_by || "unknown", text: `Question: ${clean(x.question, 800)}\nAnswer: ${clean(x.answer, 1500)}`, ref: { run_id: runId, step: x.key, question_id: Number(x.id) } });
  for (const x of await q(db, "SELECT key, approval FROM workflow_steps WHERE run_id = $1 AND COALESCE(approval->>'comment', '') <> '' ORDER BY position", [runId]))
    push({ id: `approval:${x.key}`, source: "approval_comment", trust: "human", author: x.approval.by || "unknown", text: clean(x.approval.comment, 1500), ref: { run_id: runId, step: x.key, granted: x.approval.granted ?? null } });
  for (const x of await q(
    db,
    `SELECT a.number, s.key, a.input->'pending'->'reexecute' AS rx FROM workflow_step_attempts a JOIN workflow_steps s ON s.id = a.step_id
      WHERE a.run_id = $1 AND COALESCE(a.input->'pending'->'reexecute'->>'instructions', '') <> '' ORDER BY a.id`,
    [runId],
  ))
    push({ id: `reexecute:${x.key}:${x.number}`, source: "reexecute_feedback", trust: "human", author: x.rx.requested_by || "unknown", text: clean(x.rx.instructions, 1500), ref: { run_id: runId, step: x.key, attempt: Number(x.number) } });
  const wi = await one(db, "SELECT w.code, w.title, w.description, w.source FROM workflow_runs r JOIN work_items w ON w.id = r.work_item_id WHERE r.id = $1", [runId]);
  if (wi) push({ id: `requirement:${wi.code}`, source: "requirement", trust: "requirement", author: wi.source || "work item", text: clean(`${wi.title}\n${wi.description ?? ""}`, 3000), ref: { run_id: runId, work_item: wi.code } });
  // Keep the total bounded; human answers first (they are the most specific), the requirement last.
  let budget = config.learning.maxSourceChars;
  return out.filter((s) => (budget -= s.text.length) >= 0 || s === out[0]);
}

// ---------------------------------------------------------------- analyzer contract

/** Prompt for the analyzer (pure). Sources are data, not instructions. */
export function changeAnalysisPrompt(x: AnalyzerInput): string {
  return [
    "You maintain the business-rule registry of a software team. Decide whether the human inputs below CHANGE, ADD or RETIRE a rule.",
    "Only a human statement counts (an answer, a reviewer comment, an instruction, or the requirement ticket). Ignore questions without an answer.",
    "Report nothing when the inputs only apply an existing rule, describe this one task, or are ambiguous about the rule itself.",
    "",
    "Change types:",
    "- UPDATE: an existing rule (existing_key) now says something else, everywhere it applies.",
    "- SUPERSEDE: a new rule replaces an existing one only for a narrower scope (one project, repository, market, provider, order source); the old rule keeps applying elsewhere.",
    "- DEPRECATE: an existing rule no longer applies.",
    "- CREATE: a new reusable rule that no listed rule covers.",
    "",
    "Reply with JSON only:",
    '{"candidates":[{"change_type":"UPDATE|SUPERSEDE|DEPRECATE|CREATE","existing_key":"<listed key or null>","title":"short rule name","proposed_rule":"the complete new rule text, standalone",' +
      '"domain":"e.g. refund","scope":{"type":"GLOBAL|ORGANIZATION|PROJECT|REPOSITORY","ref":"<project or repository, empty for GLOBAL>"},"applicability":{"keywords":["…"]},' +
      '"effective_from":"YYYY-MM-DD or null","evidence":[{"source_id":"<id of a source below>","quote":"<exact words copied from that source>"}],' +
      '"confidence":0.0,"uncertainty":"what a reviewer must confirm","impacted_skills":["<listed skill keys that teach the old rule>"]}]}',
    "Each evidence quote must be copied verbatim from the cited source (it is checked). Use only listed rule and skill keys.",
    "",
    `Run #${x.run.id}: ${x.run.title} — project "${x.run.project || "-"}", workflow ${x.run.workflow}, repositories ${x.run.repositories.join(", ") || "-"}`,
    "",
    "Existing rules (current versions):",
    x.rules.length ? x.rules.map((r) => `- key=${r.key} v${r.version} [${r.category}] scope=${r.scope} "${r.title}": ${r.content.replace(/\s+/g, " ").slice(0, 700)}`).join("\n") : "(none)",
    "",
    "Skills (could teach a rule):",
    x.skills.length ? x.skills.map((s) => `- key=${s.key} "${s.title}": ${s.description.replace(/\s+/g, " ").slice(0, 200)}`).join("\n") : "(none)",
    "",
    '<untrusted_input source="human inputs of this run">',
    ...x.sources.map((s) => `[source_id=${s.id} kind=${s.source} by=${s.author}]\n${s.text}`),
    "</untrusted_input>",
  ].join("\n");
}

const Candidate = z.object({
  change_type: z.enum(["CREATE", "UPDATE", "SUPERSEDE", "DEPRECATE"]),
  existing_key: z.string().nullish(),
  title: z.string().max(200).default(""),
  proposed_rule: z.string().max(6000).default(""),
  domain: z.string().max(80).default(""),
  scope: z.object({ type: z.string(), ref: z.string().nullish() }).nullish(),
  applicability: z.object({ projects: z.array(z.string()).optional(), repos: z.array(z.string()).optional(), keywords: z.array(z.string()).optional() }).nullish(),
  effective_from: z.string().nullish(),
  evidence: z.array(z.object({ source_id: z.string(), quote: z.string().max(600) })).default([]),
  confidence: z.coerce.number().default(0.5),
  uncertainty: z.string().max(1000).default(""),
  impacted_skills: z.array(z.string()).default([]),
});
export type CandidateOut = z.infer<typeof Candidate>;

/** Analyzer reply → candidates. Tolerates prose around the JSON; drops entries that do not match the contract. */
export function parseCandidates(raw: unknown): { candidates: CandidateOut[]; invalid: number } {
  let v: any = raw;
  if (typeof raw === "string") {
    const m = raw.match(/\{[\s\S]*\}/);
    try {
      v = m ? JSON.parse(m[0]) : {};
    } catch {
      v = {};
    }
  }
  const list: unknown[] = Array.isArray(v?.candidates) ? v.candidates.slice(0, 10) : [];
  const candidates: CandidateOut[] = [];
  let invalid = 0;
  for (const c of list) {
    const r = Candidate.safeParse(c);
    if (r.success) candidates.push(r.data);
    else invalid++;
  }
  return { candidates, invalid };
}

// ---------------------------------------------------------------- validation + impacts

interface RunInfo {
  id: number;
  title: string;
  owner_id: number | null;
  project: string;
  definition_key: string;
  repositories: string[];
  agent_provider?: string | null;
}

/** Deterministic checks on one candidate. Returns the proposal to store or why it was dropped. */
export function validateCandidate(
  c: CandidateOut,
  ctx: { run: RunInfo; sources: HumanSource[]; rules: KnowledgeCandidate[]; skills: KnowledgeCandidate[] },
): { ok: true; input: Omit<ProposalInput, "impacts"> & { impactedSkills: string[] } } | { ok: false; reason: string } {
  const type = c.change_type as ChangeType;
  if (!CHANGE_TYPES.includes(type)) return { ok: false, reason: `unknown change type ${c.change_type}` };
  const target = type === "CREATE" ? null : ctx.rules.find((r) => r.key === c.existing_key) ?? null;
  if (type !== "CREATE" && !target) return { ok: false, reason: `${type} names an unknown rule "${c.existing_key ?? ""}"` };
  if (target && (target.enforced || target.category === "security_policy")) return { ok: false, reason: `"${target.key}" is an enforced/security item` };
  const rule = clean(c.proposed_rule, 6000);
  if (type !== "DEPRECATE" && rule.length < 12) return { ok: false, reason: "no usable rule text" };
  if (looksSecret(rule)) return { ok: false, reason: "proposed text looks like it contains a credential" };
  // Evidence: verbatim quotes from the cited human source only (anti-fabrication).
  const byId = new Map(ctx.sources.map((s) => [s.id, s]));
  const evidence: Evidence[] = [];
  for (const e of c.evidence) {
    const s = byId.get(e.source_id);
    const quote = clean(e.quote, 600);
    if (!s || norm(quote).length < 8 || !norm(s.text).includes(norm(quote))) continue;
    if (!evidence.some((x) => x.ref.source_id === s.id && x.quote === quote)) evidence.push({ source: s.source, ref: { ...s.ref, source_id: s.id }, author: s.author, trust: s.trust, quote });
  }
  if (!evidence.length) return { ok: false, reason: "no evidence quote matches a human source verbatim" };
  // Scope: named by the analyzer, else the target's (UPDATE/DEPRECATE) or the run's project (new rules).
  let scopeType = String(c.scope?.type ?? "").toUpperCase();
  let scopeRef = clean(c.scope?.ref ?? "", 200);
  if (!(SCOPES as readonly string[]).includes(scopeType) || scopeType === "WORKFLOW" || scopeType === "STEP") {
    scopeType = type === "UPDATE" || type === "DEPRECATE" ? target!.scope_type : ctx.run.project ? "PROJECT" : "GLOBAL";
    scopeRef = type === "UPDATE" || type === "DEPRECATE" ? target!.scope_ref : ctx.run.project;
  }
  if (scopeType === "GLOBAL") scopeRef = "";
  else if (!scopeRef) return { ok: false, reason: `scope ${scopeType} without a reference` };
  if (type === "UPDATE" && (scopeType !== target!.scope_type || scopeRef.toLowerCase() !== target!.scope_ref.toLowerCase())) {
    // A change for a narrower scope than the rule's own is a SUPERSEDE: the rule keeps applying elsewhere.
    return validateCandidate({ ...c, change_type: "SUPERSEDE" }, ctx);
  }
  const uncertainty: string[] = [clean(c.uncertainty, 1000)].filter(Boolean);
  let effective: string | null = null;
  if (c.effective_from) {
    const d = new Date(c.effective_from);
    if (Number.isNaN(d.getTime())) uncertainty.push(`unparseable effective date "${c.effective_from}" ignored`);
    else effective = d.toISOString();
  }
  let confidence = Math.max(0, Math.min(1, Number(c.confidence) || 0));
  if (!evidence.some((e) => e.trust === "human")) {
    // Only the ticket text supports it: a reviewer must confirm with the BA.
    confidence = Math.min(confidence, 0.6);
    uncertainty.push("supported only by the work item text, not by a human answer or review comment");
  }
  const applicability = Object.fromEntries(Object.entries(c.applicability ?? {}).filter(([, v]) => Array.isArray(v) && v.length).map(([k, v]) => [k, (v as string[]).map((x) => clean(x, 100)).filter(Boolean).slice(0, 12)]));
  const category = target?.category ?? "business_rule";
  if (!EVOLVABLE.includes(category)) return { ok: false, reason: `category ${category} is not evolvable` };
  return {
    ok: true,
    input: {
      ownerId: ctx.run.owner_id,
      changeType: type,
      targetKey: target?.key ?? null,
      proposed: {
        title: clean(c.title, 200) || target?.title || rule.slice(0, 80),
        category,
        scope_type: scopeType,
        scope_ref: scopeRef,
        content: type === "DEPRECATE" ? "" : rule,
        ...(Object.keys(applicability).length ? { applicability } : {}),
        effective_from: effective,
      },
      domain: clean(c.domain, 80),
      confidence,
      uncertainty: uncertainty.join("; "),
      evidence,
      sourceKind: "workflow",
      sourceRunId: ctx.run.id,
      createdBy: "knowledge change detection",
      impactedSkills: c.impacted_skills.filter((k) => ctx.skills.some((s) => s.key === k)),
    },
  };
}

/** Skills, repositories and workflows a change touches; competing rules and open proposals (deterministic). */
export async function computeImpacts(
  x: { targetKey: string | null; oldRule: string; newRule: string; conflictKey?: string | null; suggestedSkills: string[]; run: RunInfo; scope: { type: string; ref: string } },
  skills: KnowledgeCandidate[],
  db: Db = pool,
) {
  const { removed } = termChange(x.oldRule, x.newRule);
  const skillHits = skills
    .map((s) => {
      const text = s.content.toLowerCase();
      const terms = removed.filter((t) => text.includes(t));
      const why = x.suggestedSkills.includes(s.key) ? "named by the analyzer" : "";
      const mentions = x.targetKey && text.includes(x.targetKey.toLowerCase()) ? `mentions ${x.targetKey}` : "";
      const reason = [terms.length ? `teaches ${terms.slice(0, 4).join(", ")}` : "", mentions, why].filter(Boolean).join("; ");
      return reason ? { key: s.key, version: s.version, title: s.title, reason } : null;
    })
    .filter(Boolean)
    .slice(0, 10) as Array<{ key: string; version: number; title: string; reason: string }>;
  const repositories = new Set(x.run.repositories);
  if (x.scope.type === "REPOSITORY" && x.scope.ref) repositories.add(x.scope.ref);
  const workflows = new Set<string>([x.run.definition_key]);
  let conflicts: any[] = [];
  if (x.targetKey) {
    for (const r of await q(
      db,
      `SELECT DISTINCT r.definition_key FROM context_snapshots cs JOIN workflow_runs r ON r.id = cs.run_id
        WHERE cs.id IN (SELECT id FROM context_snapshots ORDER BY id DESC LIMIT 2000) AND cs.content->'knowledge' @> jsonb_build_array(jsonb_build_object('key', $1::text)) LIMIT 20`,
      [x.targetKey],
    ))
      workflows.add(r.definition_key);
    for (const r of await q(db, "SELECT i.repos FROM (SELECT v.applicability->'repos' AS repos FROM knowledge_items i JOIN knowledge_versions v ON v.item_id = i.id AND v.version = i.current_version WHERE i.key = $1) i WHERE jsonb_typeof(i.repos) = 'array'", [x.targetKey]))
      for (const repo of r.repos) repositories.add(String(repo));
    conflicts = await q(db, "SELECT id, change_type, status, created_at FROM knowledge_proposals WHERE target_key = $1 AND status = 'pending' ORDER BY id", [x.targetKey]);
  }
  const competing = x.conflictKey
    ? await q(db, "SELECT key, title, scope_type, scope_ref FROM knowledge_items WHERE conflict_key = $1 AND enabled AND key IS DISTINCT FROM $2 ORDER BY key LIMIT 20", [x.conflictKey, x.targetKey])
    : [];
  return { skills: skillHits, repositories: [...repositories].sort(), workflows: [...workflows].sort(), open_proposals: conflicts.map((c) => ({ id: Number(c.id), change_type: c.change_type })), competing_rules: competing };
}

// ---------------------------------------------------------------- detection

const RULE_CATEGORIES = new Set(["business_rule", "domain_knowledge", "architecture_guideline", "coding_standard", "repository_convention"]);

async function runInfo(runId: number, db: Db): Promise<(RunInfo & { status: string; learning: any }) | undefined> {
  const r = await one(db, "SELECT r.id, r.title, r.owner_id, r.status, r.definition_key, r.selected_repositories, r.agent_provider, r.learning, r.inputs, w.project FROM workflow_runs r LEFT JOIN work_items w ON w.id = r.work_item_id WHERE r.id = $1", [runId]);
  if (!r) return undefined;
  return { id: Number(r.id), title: r.title, owner_id: r.owner_id == null ? null : Number(r.owner_id), status: r.status, definition_key: r.definition_key, repositories: r.selected_repositories ?? [], agent_provider: r.agent_provider, learning: r.learning, project: r.project || String(r.inputs?.project ?? "") };
}

/**
 * Analyse one run's human inputs and store proposals. Never throws for "nothing to do"; returns the learning record
 * (also saved on the run). Idempotent: unchanged inputs are not re-analysed unless `force`.
 */
export async function detectKnowledgeChanges(runId: number, opts: { force?: boolean } = {}, db: Db = pool) {
  if (await isEvaluationRun(runId, db)) return { status: "disabled", reason: "Benchmarks never invoke learning models" };
  const run = await runInfo(runId, db);
  if (!run) throw new Error(`run ${runId} not found`);
  const record = async (rec: Record<string, unknown>) => {
    const full = { scanned_at: new Date().toISOString(), ...rec };
    await q(db, "UPDATE workflow_runs SET learning = $2 WHERE id = $1", [runId, json(full)]);
    return full;
  };
  if (!config.learning.detectChanges && !opts.force) return { status: "disabled" };
  if (!analyzer) return record({ status: "skipped", reason: "no change analyzer registered" });
  const sources = await collectHumanSources(runId, db);
  const human = sources.filter((s) => s.trust === "human");
  const requirement = sources.find((s) => s.trust === "requirement");
  if (!human.length && !(requirement && CHANGE_SIGNAL.test(requirement.text))) return record({ status: "skipped", reason: "no human input that could change a rule", sources: sources.length });
  const all = await knowledge.candidates(db, run.owner_id);
  const signalText = [run.title, ...sources.map((s) => s.text)].join("\n");
  const rank = (items: KnowledgeCandidate[], n: number) =>
    items
      .map((k) => ({ k, s: scoreKnowledge({ ...k, reason: k.scope_type }, signalText, "agent").score }))
      .sort((a, b) => b.s - a.s || a.k.key.localeCompare(b.k.key))
      .slice(0, n)
      .map((x) => x.k);
  const rules = rank(all.filter((k) => RULE_CATEGORIES.has(k.category)), config.learning.maxRulesInPrompt);
  const skills = rank(all.filter((k) => k.category === "agent_skill"), 15);
  const inputHash = hashOf({ sources: sources.map((s) => [s.id, s.text]), rules: rules.map((r) => [r.key, r.version]) });
  if (!opts.force && run.learning?.input_hash === inputHash && run.learning?.status === "analysed") return { ...run.learning, reused: true };
  const raw = await analyzer(
    {
      run: { id: run.id, title: run.title, project: run.project, workflow: run.definition_key, repositories: run.repositories },
      sources,
      rules: rules.map((r) => ({ key: r.key, version: r.version, title: r.title, category: r.category, scope: `${r.scope_type}${r.scope_ref ? ":" + r.scope_ref : ""}`, content: r.content })),
      skills: skills.map((s) => ({ key: s.key, title: s.title, description: String((s.metadata as any)?.description ?? s.content.slice(0, 200)) })),
    },
    run,
  );
  const { candidates, invalid } = parseCandidates(raw);
  const proposals: Array<{ id: number; created: boolean; change_type: string; target: string | null; note?: string }> = [];
  const dropped: Array<{ title: string; reason: string }> = invalid ? [{ title: "(unparseable)", reason: `${invalid} candidate(s) did not match the contract` }] : [];
  // Skills the change may affect come from every visible skill, not only those shown to the analyzer.
  const allSkills = all.filter((k) => k.category === "agent_skill");
  for (const c of candidates) {
    const v = validateCandidate(c, { run, sources, rules, skills });
    if (!v.ok) {
      dropped.push({ title: c.title || c.existing_key || "?", reason: v.reason });
      continue;
    }
    const { impactedSkills, ...input } = v.input;
    const target = input.targetKey ? rules.find((r) => r.key === input.targetKey) : undefined;
    const impacts = await computeImpacts(
      { targetKey: input.targetKey ?? null, oldRule: target?.content ?? "", newRule: input.proposed.content ?? "", conflictKey: target?.conflict_key, suggestedSkills: impactedSkills, run, scope: { type: input.proposed.scope_type!, ref: input.proposed.scope_ref ?? "" } },
      allSkills,
      db,
    );
    try {
      const r = await createProposal({ ...input, impacts: { ...impacts, run_outcome: run.status } }, db);
      if (r.proposal) proposals.push({ id: Number(r.proposal.id), created: r.created, change_type: input.changeType, target: input.targetKey ?? null, note: r.reason });
      else dropped.push({ title: input.proposed.title ?? "?", reason: r.reason ?? "not stored" });
    } catch (e) {
      dropped.push({ title: input.proposed.title ?? "?", reason: (e as Error).message });
    }
  }
  return record({ status: "analysed", input_hash: inputHash, sources: sources.map((s) => ({ id: s.id, source: s.source, trust: s.trust })), candidates: candidates.length, proposals, dropped });
}

// ---------------------------------------------------------------- skill evolution

const HISTORY_MARK = /(supersed|previous|formerly|no longer|instead of|deprecated|used to|trước đây|không còn|thay vì|thay cho|\bcũ\b)/i;

/**
 * Deterministic checks of a drafted skill against the authoritative rule change: it changed, it states the new rule's
 * terms, no line still prescribes a term the rule dropped (lines marked as history are fine), a sane size, no secrets.
 */
export function validateSkillUpdate(original: string, updated: string, oldRule: string, newRule: string) {
  const { removed, added } = termChange(oldRule, newRule);
  const low = updated.toLowerCase();
  const stale = updated.split("\n").filter((l) => removed.some((t) => l.toLowerCase().includes(t)) && !HISTORY_MARK.test(l));
  const checks = [
    { name: "changed", passed: norm(original) !== norm(updated), detail: "the draft differs from the current skill" },
    { name: "states_new_rule", passed: !added.length || added.some((t) => low.includes(t)), detail: added.length ? `mentions ${added.join(", ")}` : "the rule change introduces no identifiers" },
    { name: "no_stale_instruction", passed: !stale.length, detail: stale.length ? `still prescribes ${removed.join(", ")}: ${stale.slice(0, 3).map((l) => l.trim().slice(0, 120)).join(" | ")}` : "no line prescribes a dropped term" },
    { name: "size", passed: updated.length >= original.length * 0.5 && updated.length <= original.length * 2 + 2000, detail: `${original.length} → ${updated.length} chars` },
    { name: "no_secrets", passed: !looksSecret(updated), detail: "no credential-like text" },
  ];
  return { passed: checks.every((c) => c.passed), checks };
}

/** Prompt for the skill drafter (pure). */
export function skillDraftPrompt(x: SkillDraftInput): string {
  return [
    "A business rule changed and has been approved. Update the skill below so it teaches the NEW rule.",
    "Change only what the rule change requires; keep structure, tone and everything unrelated. Do not keep the old rule as an instruction",
    "(you may mention it once as history, e.g. \"previously …\"). Reply with the complete updated skill between <skill> and </skill>, then one line",
    "<summary>what changed</summary>.",
    "",
    `Change: ${x.changeType} (scope ${x.scope})`,
    "Old rule:",
    x.oldRule || "(none)",
    "New rule (authoritative):",
    x.newRule,
    "",
    `<untrusted_input source="skill ${x.skill.key}">`,
    x.skill.content,
    "</untrusted_input>",
  ].join("\n");
}

export function parseSkillDraft(text: string): { content: string; summary?: string } {
  const body = text.match(/<skill>\s*([\s\S]*?)\s*<\/skill>/i)?.[1] ?? "";
  const summary = text.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i)?.[1];
  return { content: body.trim(), summary: summary?.trim() };
}

/**
 * After a rule change is approved: draft an update for each affected skill and store it as a child proposal with its
 * validation result. Each needs its own approval (it activates a new skill version; repository files are never written).
 */
export async function proposeSkillUpdates(parentId: number, db: Db = pool) {
  const p = await getProposal(parentId, db);
  if (!p || p.status !== "approved" || p.parent_id) return [];
  if (!config.learning.evolveSkills || !drafter) return [];
  const skills: Array<{ key: string }> = p.impacts?.skills ?? [];
  const out: Array<{ key: string; proposal_id?: number; error?: string }> = [];
  const run = p.source_run_id ? await one(db, "SELECT agent_provider FROM workflow_runs WHERE id = $1", [p.source_run_id]) : null;
  const ownerId = p.owner_id == null ? null : Number(p.owner_id);
  for (const s of skills) {
    try {
      const item = (await knowledge.get(s.key, db, ownerId)) ?? (await knowledge.get(s.key, db, null));
      if (!item || item.category !== "agent_skill" || !item.enabled) continue;
      const cur = item.versions[0];
      const newRule = String(p.proposed?.content ?? "");
      const d = await drafter({ skill: { key: item.key, title: item.title, content: cur.content }, oldRule: p.existing_rule ?? "", newRule, changeType: p.change_type, scope: `${p.proposed?.scope_type}${p.proposed?.scope_ref ? ":" + p.proposed.scope_ref : ""}` }, run);
      if (!d.content.trim()) throw new Error("the drafter returned no skill text");
      const validation = validateSkillUpdate(cur.content, d.content, p.existing_rule ?? "", newRule);
      const r = await createProposal(
        {
          ownerId,
          parentId: p.id,
          changeType: "UPDATE",
          targetKey: item.key,
          proposed: { content: d.content, scope_type: item.scope_type, scope_ref: item.scope_ref, category: "agent_skill" },
          domain: p.domain,
          confidence: validation.passed ? 0.8 : 0.3,
          uncertainty: [d.summary ? `drafter: ${d.summary}` : "", validation.passed ? "" : "automatic validation failed — review the diff"].filter(Boolean).join("; "),
          evidence: [{ source: "proposal", ref: { proposal_id: p.id, target: p.target_key ?? p.applied?.created_key }, author: p.reviewed_by ?? "", trust: "human", quote: newRule.slice(0, 400) }],
          impacts: { from_rule: p.target_key ?? p.applied?.created_key ?? null, repositories: p.impacts?.repositories ?? [], workflows: p.impacts?.workflows ?? [] },
          validation,
          sourceKind: "skill_evolution",
          sourceRunId: p.source_run_id ?? null,
          createdBy: "skill evolution",
        },
        db,
      );
      out.push({ key: item.key, proposal_id: r.proposal ? Number(r.proposal.id) : undefined, ...(r.proposal ? {} : { error: r.reason }) });
    } catch (e) {
      out.push({ key: s.key, error: (e as Error).message });
    }
  }
  return out;
}
