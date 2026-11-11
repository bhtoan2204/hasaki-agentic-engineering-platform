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
  const mandatory = (x: (typeof scored)[number]) =>
    x.k.reason === "assigned to step" ||
    x.k.reason.startsWith("selected for this re-execution") ||
    x.k.enforced === true;
  const wantsInline = (x: (typeof scored)[number]) =>
    mandatory(x) || x.k.metadata?.load !== "on_demand";
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
    const disclosure = !companion && indexed < opts.indexSize ? "index" : "search";
    if (disclosure === "index") indexed++;
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
