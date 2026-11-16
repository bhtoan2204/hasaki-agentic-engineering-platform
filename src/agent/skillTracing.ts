import type { ContextPack } from "../context/pack.ts";
import type { ResolvedContext } from "../workflow/context.ts";

export type SkillState = "selected" | "injected" | "loaded" | "activated";
export interface SkillTrace {
  key: string;
  version: number;
  tier: "inline" | "index" | "search" | "pack";
  tokens: number;
  state: SkillState;
  states: SkillState[];
  evidence: string[];
  loaded_unused: boolean;
  provider_limited: boolean;
}
export interface SkillRead {
  key: string;
  version: number;
  offset: number;
  end: number;
}

export function selectedSkills(
  ctx: Pick<ResolvedContext, "knowledge" | "disclosure" | "overridden">,
): SkillTrace[] {
  const traces: SkillTrace[] = ctx.knowledge
    .filter((k) => k.category === "agent_skill")
    .map((k) => ({
      key: k.key,
      version: k.version,
      tier: ctx.disclosure.find((d) => d.key === k.key)?.disclosure ?? "inline",
      tokens: 0,
      state: "selected",
      states: ["selected"],
      evidence: [],
      loaded_unused: false,
      provider_limited: false,
    }));
  for (const k of ctx.overridden.filter((k) => k.reason === "unavailable"))
    traces.push({
      key: k.key,
      version: k.version,
      tier: "search",
      tokens: 0,
      state: "selected",
      states: ["selected"],
      evidence: [k.detail ?? "unavailable"],
      loaded_unused: false,
      provider_limited: true,
    });
  return traces;
}

export function injectSkills(
  traces: SkillTrace[],
  ctx: Pick<ResolvedContext, "knowledge" | "disclosure">,
  pack?: ContextPack,
): void {
  for (const trace of traces) {
    if (trace.provider_limited) continue;
    const k = ctx.knowledge.find((k) => k.key === trace.key);
    if (!k) continue;
    const entry = pack?.entries.find((e) => e.id === `knowledge:${k.id ?? k.key}:v${k.version}`);
    if (pack && !entry && trace.tier !== "index") continue;
    if (!pack && trace.tier === "search") continue;
    if (entry) {
      trace.tier = entry.truncated ? "index" : "pack";
      trace.tokens = Math.ceil(entry.body.length / 4);
    } else {
      trace.tokens = Math.ceil(
        (trace.tier === "inline"
          ? k.content
          : `${k.key} ${k.title} ${String(k.metadata.description ?? "")}`
        ).length / 4,
      );
    }
    trace.state = "injected";
    trace.states.push("injected");
    trace.loaded_unused = trace.tier === "inline" || trace.tier === "pack";
  }
}

export function deriveSkillActivation(
  traces: SkillTrace[],
  knowledge: Pick<ResolvedContext, "knowledge">["knowledge"],
  reads: SkillRead[],
  declaration: unknown,
): SkillTrace[] {
  const applied = new Set(
    Array.isArray(declaration) ? declaration.filter((k): k is string => typeof k === "string") : [],
  );
  return traces.map((trace) => {
    if (trace.provider_limited) return trace;
    const k = knowledge.find((k) => k.key === trace.key && k.version === trace.version);
    const pages = reads
      .filter((r) => r.key === trace.key && r.version === trace.version)
      .sort((a, b) => a.offset - b.offset);
    let end = 0;
    for (const page of pages) if (page.offset <= end) end = Math.max(end, page.end);
    const loaded = !!k && end >= k.content.length && pages.length > 0;
    const inline =
      trace.states.includes("injected") && (trace.tier === "inline" || trace.tier === "pack");
    const bodyAvailable = inline || loaded;
    const activated = bodyAvailable && applied.has(trace.key);
    const states: SkillState[] = trace.states.filter((s) => s === "selected" || s === "injected");
    const evidence: string[] = [];
    if (loaded) {
      states.push("loaded");
      evidence.push("read_knowledge:complete_body");
    }
    if (applied.has(trace.key)) evidence.push("submit_result:skills_applied");
    if (activated) states.push("activated");
    return {
      ...trace,
      states,
      state: states.at(-1)!,
      evidence,
      loaded_unused: (pages.length > 0 || inline) && !activated,
    };
  });
}
