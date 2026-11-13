import { existsSync } from "node:fs";
import { config } from "../config.ts";
import { skillAvailability } from "./external.ts";
import { resolve, relative } from "node:path";
import { pool, q } from "../db/pool.ts";
import { TEMPLATES } from "../workflow/templates.ts";
import { knowledgeRestricted, readableRepositoryNames } from "./visibility.ts";
import { planExternalSkills } from "./externalImport.ts";
import { knowledge, KNOWLEDGE_SEEDS } from "./service.ts";
import { auditKnowledge, type AuditItem, type AuditUsage } from "./audit.ts";

export async function loadKnowledgeAuditData(
  options: { windowDays?: number; userId?: number; offline?: boolean } = {},
) {
  const windowDays = Number.isFinite(options.windowDays)
    ? Math.min(365, Math.max(1, Math.floor(options.windowDays!)))
    : 7;
  const external = planExternalSkills(resolve(import.meta.dirname, "../../skills/external"));
  let items: AuditItem[] = [...KNOWLEDGE_SEEDS, ...external.candidates].map((i) => ({
    ...i,
    enabled: true,
  }));
  let steps = TEMPLATES.flatMap((t) => t.spec.steps as Array<{ key: string; type: string }>);
  const usage: Record<string, AuditUsage> = {};
  let totalPacks = 0;
  let repositories: string[] | undefined;
  const nativeSources: Array<{ repo: string; path: string; sha256: string }> = [];
  const roleFootprint: Record<string, { packs: number; tokens: number }> = {};
  let privateFindings: Record<string, number> = {};
  let privateCounts: ReturnType<typeof auditKnowledge>["counts"] | undefined;
  if (!options.offline) {
    const rows = await knowledge.list({ all: true });
    const privateReport = auditKnowledge({
      items: rows.filter((r) => r.owner_id != null && r.owner_id !== options.userId),
      steps,
    });
    privateCounts = privateReport.counts;
    privateFindings = privateReport.findingCounts;
    const readable = await readableRepositoryNames(options.userId);
    const visible = rows.filter(
      (r) =>
        (r.owner_id == null || r.owner_id === options.userId) && !knowledgeRestricted(r, readable),
    );
    const present = new Set(visible.map((r) => r.key));
    items = [...visible, ...items.filter((i) => !present.has(i.key))];
    const definitions = await q(
      pool,
      "SELECT v.spec FROM workflow_definitions d JOIN workflow_definition_versions v ON v.definition_id=d.id AND v.version=d.latest_version WHERE NOT d.archived AND (d.owner_id IS NULL OR d.owner_id=$1)",
      [options.userId ?? null],
    );
    steps = [...steps, ...definitions.flatMap((r) => r.spec.steps ?? [])];
    repositories = (await q(pool, "SELECT name FROM repositories")).map((r) => r.name);
    const snapshots = await q(
      pool,
      "SELECT content FROM context_snapshots WHERE created_at >= now()-$1::int*interval '1 day'",
      [windowDays],
    );
    const packs = await q(
      pool,
      "SELECT p.content,s.type,s.config,cs.content AS snapshot FROM agent_context_packs p JOIN workflow_steps s ON s.id=p.step_id JOIN context_snapshots cs ON cs.id=p.snapshot_id WHERE p.created_at >= now()-$1::int*interval '1 day'",
      [windowDays],
    );
    const attempts = await q(
      pool,
      "SELECT metrics FROM workflow_step_attempts WHERE started_at >= now()-$1::int*interval '1 day'",
      [windowDays],
    );
    const entry = (key: string) =>
      (usage[key] ??= { selected: 0, packs: 0, loaded: 0, truncated: 0 });
    for (const row of snapshots)
      for (const k of row.content.knowledge ?? []) entry(k.key).selected++;
    totalPacks = packs.length;
    for (const row of snapshots) nativeSources.push(...(row.content.native_sources ?? []));
    for (const row of packs) {
      const role = row.config?.independent ? "review" : row.type;
      const footprint = (roleFootprint[role] ??= { packs: 0, tokens: 0 });
      footprint.packs++;
      footprint.tokens += Number(row.content.estimated_tokens ?? 0);
    }
    for (const row of packs)
      for (const item of items) {
        const entries = (row.content.entries ?? []).filter((e: { id: string }) =>
          e.id.startsWith(`knowledge:${item.id ?? item.key}:`),
        );
        if (entries.length) entry(item.key).packs++;
        const indexOnly = (row.snapshot?.prompt_plan?.knowledge ?? []).some(
          (d: { key: string; disclosure: string }) =>
            d.key === item.key && d.disclosure === "index",
        );
        if (!indexOnly && entries.some((e: { truncated?: boolean }) => e.truncated))
          entry(item.key).truncated++;
      }
    for (const row of attempts)
      for (const key of row.metrics?.skills_loaded ?? []) entry(key).loaded++;
  }
  const providerAvailability = Object.fromEntries(
    items.map((i) => [
      i.key,
      ["claude", "codex", "cursor", "antigravity"].some(
        (p) => skillAvailability(i.metadata, p).available,
      ),
    ]),
  );
  const missingPaths: Record<string, string[]> = {};
  for (const item of items) {
    const sources = item.metadata?.source;
    if (!Array.isArray(sources)) continue;
    for (const source of sources) {
      const root = config.repositories[String(source.repo)];
      if (!root || typeof source.path !== "string") continue;
      const file = resolve(root, source.path);
      if (relative(root, file).startsWith("..")) continue;
      if (!existsSync(file)) (missingPaths[item.key] ??= []).push(source.path);
    }
  }
  const input = {
    items,
    steps,
    usage: options.offline ? undefined : usage,
    totalPacks,
    repositories,
    windowDays,
    providerAvailability,
    missingPaths,
    nativeSources,
    roleFootprint,
  };
  const report = auditKnowledge(input);
  return {
    input,
    report: {
      ...report,
      sources: { database: !options.offline, external: true, seeds: true },
      privateAggregates: privateCounts ? { ...privateCounts, findings: privateFindings } : null,
    },
  };
}

export async function loadKnowledgeAudit(
  options: { windowDays?: number; userId?: number; offline?: boolean } = {},
) {
  return (await loadKnowledgeAuditData(options)).report;
}
