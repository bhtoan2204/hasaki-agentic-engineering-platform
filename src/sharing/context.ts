import type { Db } from "../db/pool.ts";
import { q } from "../db/pool.ts";
import { definitions } from "../workflow/definitions.ts";
import { loadAgentConfiguration } from "../agent/configurationStore.ts";
import type { AgentConfiguration } from "../agent/configuration.ts";
import { resolveAgentProvider } from "../agent/provider.ts";
import { resolveStepAgent } from "../agent/stepAgent.ts";
import {
  classifyProfile,
  resolveProfile,
  type Profile,
  type ProfileDecision,
} from "../workflow/profiles.ts";
import type { WorkflowSpec } from "../workflow/types.ts";
import { canonicalJson, profileOf, rubricHash, sha256, type WorkflowRef } from "./key.ts";

/** What makes two runs of one workflow "the same analysis", read before any run exists. */
export interface AnalysisContext {
  workflow: WorkflowRef;
  rubricHash: string;
  model: string;
  profile: Profile;
  /** Live deterministic AUTO decision passed into startRun so classification never runs twice or inside a claim tx. */
  profileDecision?: ProfileDecision;
  /** Providers of the agent steps (for provenance; not part of the key by itself: the model part covers them). */
  providers: string[];
  /** The run's owner has a personal copy of the workflow: what they run is not the shared definition (never shared). */
  personal: boolean;
  /** The skills the rubric pins, with their version, sorted by key. */
  pinned: Array<{ key: string; version: number }>;
}

/** Deterministic inputs used to resolve execution profile (AUTO) without an LLM call. */
export interface ProfileInputs {
  profile?: string | null;
  title?: string;
  description?: string;
  project?: string;
  repositories?: string[];
}

/** A past run's context (backfill): its definition version, its frozen agent configuration, the skills as of its start. */
export interface RunContextAt {
  version: number;
  configuration: AgentConfiguration;
  startedAt: Date;
}

function resolveSharedProfile(
  spec: WorkflowSpec | null,
  input: ProfileInputs | undefined,
  provider: string | null,
): { profile: Profile; profileDecision?: ProfileDecision; spec: WorkflowSpec | null } {
  const explicit = input?.profile != null && input.profile !== "" ? profileOf(input.profile) : null;
  if (explicit) {
    if (!spec) return { profile: explicit, spec: null };
    const applied = resolveProfile(spec, {
      profile: explicit,
      requested: explicit,
      confidence: "high",
      reasons: [],
      warnings: [],
      signals: {
        high_risk_term: null,
        multi_repo_terms: false,
        big_change_terms: null,
        small_change_terms: null,
        bug_terms: null,
        repositories: [],
        matching_repositories: 0,
        declared_risk: null,
        implementation_complexity: "unknown",
        business_risk: "unknown",
      },
    });
    return { profile: applied.decision.profile, spec: applied.spec };
  }
  const raw = classifyProfile(
    {
      title: input?.title ?? "",
      description: input?.description ?? "",
      project: input?.project ?? "",
      repositories: input?.repositories ?? [],
      knownRepository: null,
      matchingRepositories: 0,
      declaredRisk: null,
      provider,
    },
    "AUTO",
  );
  if (!spec) return { profile: raw.profile, profileDecision: raw, spec: null };
  const resolved = resolveProfile(spec, raw);
  return {
    profile: resolved.decision.profile,
    profileDecision: resolved.decision,
    spec: resolved.spec,
  };
}

/** Resolve execution profile for a code-assessment query without reading secrets or calling any LLM. */
export async function codeAssessmentProfile(
  db: Db,
  ownerId: number | null,
  input: Pick<ProfileInputs, "profile" | "title" | "project" | "repositories">,
): Promise<Profile> {
  if (input.profile != null && input.profile !== "") return profileOf(input.profile);
  const dv = await definitions.version("codebase-assessment", undefined, db, ownerId);
  return resolveSharedProfile(dv?.spec ?? null, input, null).profile;
}

/**
 * The definition, rubric, profile and model parts of a key, as a run started now would use them:
 *  - workflow: the latest published version of the shared definition (what startRun resolves);
 *  - rubric: the instructions, output contracts and schemas of every agent step of that version, plus the skills those
 *    steps name, at their current version;
 *  - profile: deterministic AUTO classification (zero LLM call, never inside a claim transaction) or an explicit
 *    run.profile (backfill);
 *  - model: each agent step's provider/model as resolveStepAgent gives it for that profile, plus a fingerprint of the
 *    configuration of the providers involved.
 */
export async function analysisContext(
  db: Db,
  definitionKey: string,
  provider: string | undefined,
  at?: RunContextAt,
  ownerId?: number | null,
  profileInputs?: ProfileInputs,
): Promise<AnalysisContext> {
  // The definition a run of this owner would use: startRun resolves the owner's own copy before the shared one.
  const dv = await definitions.version(definitionKey, at?.version, db, ownerId ?? null);
  if (!dv) throw new Error(`workflow "${definitionKey}" has no published version`);
  const shared = ownerId ? await definitions.version(definitionKey, at?.version, db, null) : dv;
  const personal = !shared || shared.definition_id !== dv.definition_id;
  const cfg = at ? at.configuration : await loadAgentConfiguration(db);
  const chosen = resolveAgentProvider(provider || cfg.default_provider);
  const resolved = resolveSharedProfile(dv.spec, profileInputs, chosen);
  const rubricSteps = dv.spec.steps.filter((s) => s.type === "agent" || s.type === "coding_agent");
  const agentSteps = (resolved.spec ?? dv.spec).steps.filter(
    (s) => s.type === "agent" || s.type === "coding_agent",
  );
  const skillKeys = [
    ...new Set(
      rubricSteps.flatMap((s) =>
        Array.isArray(s.config?.skills) ? (s.config.skills as unknown[]).map(String) : [],
      ),
    ),
  ];
  const versions = !skillKeys.length
    ? []
    : at
      ? await q<{ key: string; current_version: number }>(
          db,
          `SELECT i.key, max(v.version) AS current_version FROM knowledge_items i JOIN knowledge_versions v ON v.item_id = i.id
            WHERE i.owner_id IS NULL AND i.key = ANY($1) AND v.created_at <= $2 GROUP BY i.key`,
          [skillKeys, at.startedAt],
        )
      : await q<{ key: string; current_version: number }>(
          db,
          "SELECT key, current_version FROM knowledge_items WHERE owner_id IS NULL AND key = ANY($1)",
          [skillKeys],
        );
  const rubric = rubricHash({
    instructions: canonicalJson(
      rubricSteps.map((s) => ({
        key: s.key,
        instructions: s.config?.instructions ?? null,
        output_contract: s.config?.output_contract ?? null,
        output_schema: s.config?.output_schema ?? null,
      })),
    ),
    pinned: versions.map((v) => ({ key: v.key, version: Number(v.current_version) })),
  });
  const agents = agentSteps
    .map((s) =>
      resolveStepAgent(
        { agent_provider: chosen, profile: resolved.profile, agent_configuration: cfg },
        {
          type: s.type,
          config: (s.config ?? {}) as Record<string, unknown>,
        },
      ),
    )
    .filter((a) => a !== null);
  const providers = [...new Set(agents.map((a) => a.provider))].sort();
  const models = [
    ...new Set(agents.map((a) => `${a.provider}/${a.model ?? "cli-default"}`)),
  ].sort();
  const configuration = sha256(
    canonicalJson(
      providers.map((p) => ({
        p,
        defaults: cfg.providers[p]?.defaults ?? null,
        profiles: cfg.providers[p]?.profiles ?? null,
      })),
    ),
  ).slice(0, 16);
  return {
    workflow: { key: definitionKey, version: dv.version },
    rubricHash: rubric,
    model: `${models.join("+") || `${chosen}/cli-default`}#cfg:${configuration}`,
    profile: resolved.profile,
    ...(resolved.profileDecision ? { profileDecision: resolved.profileDecision } : {}),
    providers: providers.length ? providers : [chosen],
    personal,
    pinned: versions
      .map((v) => ({ key: v.key, version: Number(v.current_version) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  };
}
