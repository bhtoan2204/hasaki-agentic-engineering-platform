import { tokens as wordTokens } from "../repos/service.ts";

/**
 * Progressive disclosure and context budgeting (pure, deterministic, unit-tested).
 *
 * Knowledge resolved for a step is disclosed in three tiers:
 *   inline  — full text in the system prompt: explicitly assigned items, enforced policies, items marked load=inline
 *             (repository conventions), within `inlineKnowledgeTokens` (most relevant first);
 *   index   — one line (key + description) in the prompt for the most relevant on-demand skills/docs; the agent
 *             loads the body with read_knowledge;
 *   search  — everything else that applies; reachable through search_knowledge, never shown up front.
 * Upstream step outputs share `upstreamTokens`; direct dependencies weigh twice as much as earlier ancestors; an output
 * that does not fit is replaced by a structural summary and the agent can fetch the full value with read_step_output.
 */

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export interface KnowledgeLike {
  key: string;
  title: string;
  category: string;
  content: string;
  reason: string;
  enforced?: boolean;
  scope_type?: string;
  metadata?: any;
}
export type Disclosure = "inline" | "index" | "search";
export interface DisclosureEntry {
  key: string;
  disclosure: Disclosure;
  score: number;
  tokens: number;
  why: string;
}

/** Relevance of a knowledge item to the request: word overlap with title/description/key, plus small priors. */
export function scoreKnowledge(
  k: KnowledgeLike,
  requestText: string,
  stepType: string,
): { score: number; why: string } {
  const want = new Set(wordTokens(requestText));
  const desc = String(k.metadata?.description ?? "");
  const fields: Array<[string, string[], number]> = [
    ["title", wordTokens(k.title + " " + k.key.replace(/[._-]/g, " ")), 3],
    ["description", wordTokens(desc), 2],
    ["content", wordTokens(k.content.slice(0, 4000)), 0.25],
  ];
  let score = 0;
  const hits: string[] = [];
  for (const [name, toks, w] of fields) {
    const h = [...new Set(toks.filter((t) => want.has(t)))];
    if (h.length) {
      score += w * h.length;
      hits.push(`${name}: ${h.slice(0, 5).join(", ")}`);
    }
  }
  if (k.reason.startsWith("REPOSITORY") || k.scope_type === "REPOSITORY") score += 2;
  if (stepType === "coding_agent" && /coding_standard|repository_convention/.test(k.category))
    score += 1;
  return { score: Math.round(score * 100) / 100, why: hits.join("; ") || "no keyword overlap" };
}

export function planKnowledge(
  items: KnowledgeLike[],
  opts: { requestText: string; stepType: string; inlineTokens: number; indexSize: number },
): DisclosureEntry[] {
  const scored = items.map((k) => ({
    k,
    ...scoreKnowledge(k, opts.requestText, opts.stepType),
    tokens: estimateTokens(k.content),
  }));
  // Unverified AI observations are never authoritative: they cannot be mandatory or inline, whatever their load flag.
  const unverified = (x: (typeof scored)[number]) => knowledgeTier(x.k) === "unverified_suggestion";
  const mandatory = (x: (typeof scored)[number]) => isMandatory(x.k);
  const wantsInline = (x: (typeof scored)[number]) =>
    !unverified(x) && (mandatory(x) || x.k.metadata?.load !== "on_demand");
  const out: DisclosureEntry[] = [];
  let used = 0;
  // inline: mandatory first, then the most relevant inline-type items while the budget lasts; overflow → index
  const inlineCands = scored
    .filter(wantsInline)
    .sort(
      (a, b) =>
        Number(mandatory(b)) - Number(mandatory(a)) ||
        b.score - a.score ||
        a.k.key.localeCompare(b.k.key),
    );
  const demoted: typeof scored = [];
  for (const x of inlineCands) {
    if (mandatory(x) || used + x.tokens <= opts.inlineTokens) {
      used += x.tokens;
      out.push({
        key: x.k.key,
        disclosure: "inline",
        score: x.score,
        tokens: x.tokens,
        why: mandatory(x) ? "mandatory (assigned/enforced)" : x.why,
      });
    } else demoted.push(x);
  }
  const rest = [...demoted, ...scored.filter((x) => !wantsInline(x))].sort(
    (a, b) => b.score - a.score || a.k.key.localeCompare(b.k.key),
  );
  // A skill's supporting file (reference doc, script) is reached from its parent skill's footer or search_knowledge;
  // it never takes an index slot.
  let indexed = 0;
  for (const x of rest) {
    const companion = !!x.k.metadata?.parent_skill;
    // Unverified observations always stay visible as an index line (with notice) and never use a slot.
    const pinned = unverified(x) && !companion;
    const disclosure = pinned || (!companion && indexed < opts.indexSize) ? "index" : "search";
    if (disclosure === "index" && !pinned) indexed++;
    out.push({
      key: x.k.key,
      disclosure,
      score: x.score,
      tokens: x.tokens,
      why: companion
        ? `supporting file of ${x.k.metadata.parent_skill}; ${x.why}`
        : demoted.includes(x)
          ? `over inline budget; ${x.why}`
          : x.why,
    });
  }
  return out;
}

// ---------------------------------------------------------------- upstream outputs

/** Structural summary: keeps keys and shape, shortens long strings and arrays, bounded depth. Deterministic. */
export function summarizeValue(v: unknown, maxChars: number): string {
  const shrink = (x: unknown, depth: number, strMax: number, arrMax: number): unknown => {
    if (typeof x === "string")
      return x.length > strMax ? x.slice(0, strMax) + `… (+${x.length - strMax} chars)` : x;
    if (Array.isArray(x)) {
      const head = x.slice(0, arrMax).map((y) => shrink(y, depth + 1, strMax, arrMax));
      return x.length > arrMax ? [...head, `… (+${x.length - arrMax} more items)`] : head;
    }
    if (x && typeof x === "object") {
      if (depth >= 3) return `{… ${Object.keys(x).length} keys}`;
      return Object.fromEntries(
        Object.entries(x).map(([k, y]) => [k, shrink(y, depth + 1, strMax, arrMax)]),
      );
    }
    return x;
  };
  // Most detailed level that fits the budget wins, so a bigger share really buys more detail.
  for (const [strMax, arrMax] of [
    [4000, 200],
    [2000, 80],
    [1000, 40],
    [600, 20],
    [400, 12],
    [300, 8],
    [150, 5],
    [80, 3],
    [40, 1],
  ] as const) {
    const s = JSON.stringify(shrink(v, 0, strMax, arrMax), null, 1);
    if (s.length <= maxChars) return s;
  }
  const s = JSON.stringify(shrink(v, 0, 40, 1));
  return s.length > maxChars ? s.slice(0, maxChars) + "…" : s;
}

export interface UpstreamPlanEntry {
  attempt_id: number | null;
  mode: "full" | "summary";
  full_tokens: number;
  tokens: number;
  direct: boolean;
}

/** Allocate the upstream budget (weighted fair share with redistribution of unused share). */
export function planUpstream(
  outputs: Record<string, { output: unknown; attempt_id: number | null }>,
  direct: string[],
  budgetTokens: number,
) {
  const items = Object.entries(outputs).map(([key, u]) => {
    const full = JSON.stringify(u.output, null, 2) ?? "null";
    return { key, u, full, fullTokens: estimateTokens(full), weight: direct.includes(key) ? 2 : 1 };
  });
  const share: Record<string, number> = {};
  let remaining = budgetTokens;
  let open = [...items];
  // Water-filling: items that fit within their share keep full text; leftover is redistributed to the rest.
  while (open.length) {
    const totalW = open.reduce((a, x) => a + x.weight, 0);
    const fits = open.filter((x) => x.fullTokens <= (remaining * x.weight) / totalW);
    if (!fits.length) {
      for (const x of open)
        share[x.key] = Math.max(64, Math.floor((remaining * x.weight) / totalW));
      break;
    }
    for (const x of fits) {
      share[x.key] = x.fullTokens;
      remaining -= x.fullTokens;
    }
    open = open.filter((x) => !fits.includes(x));
  }
  const plan: Record<string, UpstreamPlanEntry> = {};
  const text: Record<string, string> = {};
  for (const x of items) {
    const full = x.fullTokens <= share[x.key];
    text[x.key] = full ? x.full : summarizeValue(x.u.output, share[x.key] * 4);
    plan[x.key] = {
      attempt_id: x.u.attempt_id,
      mode: full ? "full" : "summary",
      full_tokens: x.fullTokens,
      tokens: estimateTokens(text[x.key]),
      direct: x.weight === 2,
    };
  }
  return { plan, text };
}

// ---------------------------------------------------------------- code retrieval ranking

export interface CodeHit {
  repo: string;
  path: string;
  line?: number;
  endLine?: number;
  symbol?: string;
  /** Raw retrieval score from the index (symbol match / keyword match). */
  score: number;
  via: "symbol" | "keyword" | "dependency";
}
export interface RankedCodeHit extends CodeHit {
  confidence: number;
  evidence: string[];
}

/**
 * Rank code hits for a task (pure, deterministic): direct matches keep their score, files that the best direct hits
 * depend on get a discounted one-step expansion, duplicates (same repo, path, range) collapse to the strongest hit
 * with merged evidence, and every hit carries a 0..1 confidence relative to the best one plus the reasons it ranked.
 * `deps` maps "repo:path" to the files it imports/calls. Nothing is fetched here; the caller applies its own budget.
 */
export function rankCodeHits(
  hits: CodeHit[],
  deps: Record<string, Array<{ repo: string; path: string }>>,
  opts: { limit: number; expandTop?: number; dependencyWeight?: number },
): RankedCodeHit[] {
  const weight = opts.dependencyWeight ?? 0.5;
  const keyOf = (h: { repo: string; path: string; line?: number; endLine?: number }) =>
    `${h.repo}:${h.path}:${h.line ?? ""}-${h.endLine ?? ""}`;
  const byKey = new Map<string, RankedCodeHit>();
  const add = (h: CodeHit, evidence: string) => {
    const k = keyOf(h);
    const cur = byKey.get(k);
    if (!cur) return void byKey.set(k, { ...h, confidence: 0, evidence: [evidence] });
    if (!cur.evidence.includes(evidence)) cur.evidence.push(evidence);
    if (h.score > cur.score)
      Object.assign(cur, { score: h.score, via: h.via, symbol: h.symbol ?? cur.symbol });
  };
  const direct = [...hits].sort((a, b) => b.score - a.score || keyOf(a).localeCompare(keyOf(b)));
  for (const h of direct)
    add(h, `${h.via} match${h.symbol ? ` "${h.symbol}"` : ""} (score ${h.score})`);
  for (const h of direct.slice(0, opts.expandTop ?? 3)) {
    for (const d of deps[`${h.repo}:${h.path}`] ?? [])
      add(
        { repo: d.repo, path: d.path, score: h.score * weight, via: "dependency" },
        `dependency of ${h.repo}:${h.path}`,
      );
  }
  const ranked = [...byKey.values()].sort(
    (a, b) => b.score - a.score || keyOf(a).localeCompare(keyOf(b)),
  );
  const best = ranked[0]?.score || 1;
  for (const r of ranked)
    r.confidence = Math.round(Math.min(1, Math.max(0, r.score / best)) * 100) / 100;
  return ranked.slice(0, Math.max(0, opts.limit));
}

// ---------------------------------------------------------------- knowledge tiers

export type KnowledgeTier =
  "organizational_rule" | "approved_knowledge" | "task_observation" | "unverified_suggestion";

/** Label an item with its authority tier. Only enforced rules are authoritative; unknown or unverified never are. */
export function knowledgeTier(k: {
  category: string;
  enforced?: boolean;
  metadata?: any;
}): KnowledgeTier {
  if (k.category === "task_memory") {
    // Production task_memory stores provenance under metadata.memory (see knowledge/memory.ts); missing = unverified.
    const t = String(k.metadata?.memory?.trust ?? "unverified");
    return t === "approved" || t === "verified" ? "task_observation" : "unverified_suggestion";
  }
  if (k.enforced === true) return "organizational_rule";
  return "approved_knowledge";
}

/**
 * Apply rankCodeHits to a search_code result using the edges of a find_dependencies result: hits are deduplicated,
 * files the best hits depend on are added as discounted candidates, and every hit carries rank_confidence + evidence.
 * Pure; a body without a hits array is returned unchanged.
 */
export function rankRetrievedCode(search: any, dependencies: any[] | undefined, limit = 12): any {
  const raw: any[] = Array.isArray(search?.hits) ? search.hits : [];
  if (!raw.length) return search;
  const keyOf = (r: string, p: string, a?: number, b?: number) => `${r}:${p}:${a ?? ""}-${b ?? ""}`;
  const original = new Map<string, any>();
  const hits: CodeHit[] = raw.map((h) => {
    const line = h.line_range?.[0];
    const endLine = h.line_range?.[1];
    const k = keyOf(h.repository, h.file_path, line, endLine);
    const prev = original.get(k);
    // Duplicates collapse to the strongest hit, so its snippet/metadata are the ones kept.
    if (!prev || (Number(h.confidence) || 0) > (Number(prev.confidence) || 0)) original.set(k, h);
    return {
      repo: h.repository,
      path: h.file_path,
      line,
      endLine,
      symbol: h.qualified_name ?? h.symbol_name,
      score: Number(h.confidence) || 0,
      via: h.qualified_name || h.symbol_name ? "symbol" : "keyword",
    };
  });
  const deps: Record<string, Array<{ repo: string; path: string }>> = {};
  for (const e of dependencies ?? []) {
    const k = `${e.repository}:${e.file_path}`;
    for (const c of e.candidate_definitions ?? [])
      (deps[k] ??= []).push({ repo: c.repository, path: c.file_path });
  }
  const ranked = rankCodeHits(hits, deps, { limit });
  return {
    ...search,
    hits: ranked.map((r) => {
      const o = original.get(keyOf(r.repo, r.path, r.line, r.endLine));
      const extra = { rank_confidence: r.confidence, evidence: r.evidence };
      return o
        ? { ...o, ...extra }
        : { repository: r.repo, file_path: r.path, match_type: r.via, ...extra };
    }),
  };
}

/** Explicit label for items that must never be read as authoritative. */
export const tierNotice = (t: KnowledgeTier) =>
  t === "unverified_suggestion"
    ? "quan sát chưa xác minh (unverified observation): không phải rule"
    : undefined;

export function isMandatory(k: KnowledgeLike): boolean {
  return (
    knowledgeTier(k) !== "unverified_suggestion" &&
    (k.enforced === true ||
      k.category === "business_rule" ||
      k.reason === "assigned to step" ||
      k.reason.startsWith("selected for this re-execution"))
  );
}
