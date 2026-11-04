import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { config } from "../config.ts";
import { pool, q, one } from "../db/pool.ts";
import { knowledge } from "./service.ts";

/**
 * Cross-task memory on top of the knowledge registry (category `task_memory`, scope REPOSITORY, loaded on demand).
 *
 * Per completed run and repository two items are written:
 *  - `memory.run-<id>.<repo>.facts`        trust "verified": platform-derived facts only (changed files, commit, the
 *                                           verification/test outcomes). Enabled immediately.
 *  - `memory.run-<id>.<repo>.conclusions`  trust "unverified": what the agents concluded (summaries, decisions). Stored
 *                                           DISABLED — never loaded into a prompt until a human approves it.
 * Agent text is quoted, never phrased as instructions. Each item records repo, commit SHA, run, timestamps and trust;
 * items whose files changed on the base branch since that commit are treated as stale and not loaded.
 */

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-C", cwd, ...args], { maxBuffer: 8 << 20 })).stdout.trim();
const quote = (s: string, max = 1500) => String(s ?? "").replace(/<\/?untrusted_input[^>]*>/gi, "").slice(0, max).split("\n").map((l) => `> ${l}`).join("\n");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");

export type Trust = "verified" | "unverified" | "approved" | "rejected";
export interface MemoryMeta {
  run_id: number;
  work_item: string | null;
  repo: string;
  commit_sha: string;
  base_branch: string;
  files: string[];
  trust: Trust;
  confidence: "high" | "medium" | "low";
  extracted_at: string;
  sources: string[];
  approved_by?: string;
  approved_at?: string;
}

/** Build the two memory items of one repository from run data (pure: easy to test). */
export function buildMemoryItems(x: {
  runId: number;
  title: string;
  workItem: string | null;
  repo: string;
  sha: string;
  files: string[];
  verification?: any;
  independentVerdict?: string | null;
  testsPassed?: boolean | null;
  conclusions: Array<{ step: string; text: string }>;
}) {
  const now = new Date().toISOString();
  const base = { run_id: x.runId, work_item: x.workItem, repo: x.repo, commit_sha: x.sha, base_branch: config.baseBranch, files: x.files.slice(0, 50), extracted_at: now };
  const keyBase = `memory.run-${x.runId}.${slug(x.repo)}`;
  const facts = [
    `Task ${x.workItem ?? `run #${x.runId}`}: ${x.title}`,
    `Repository ${x.repo} at commit ${x.sha.slice(0, 12)} (run #${x.runId}).`,
    x.files.length ? `Files changed for this task:\n${x.files.slice(0, 30).map((f) => `- ${f}`).join("\n")}` : "No files changed.",
    x.verification ? `Build/test verification: ${x.verification.status ?? x.verification.outcome}${x.verification.repairs ? ` after ${x.verification.repairs} repair(s)` : ""}.` : "",
    x.independentVerdict ? `Independent verification verdict: ${x.independentVerdict}.` : "",
    x.testsPassed != null ? `Test step: ${x.testsPassed ? "passed" : "failed"}.` : "",
  ].filter(Boolean).join("\n");
  const items = [
    {
      key: `${keyBase}.facts`,
      title: `${x.workItem ?? `Run #${x.runId}`} — where it changed ${x.repo}`,
      content: facts,
      enabled: true,
      meta: { ...base, trust: "verified" as Trust, confidence: "high" as MemoryMeta["confidence"], sources: ["git", "verification", "test step"].filter((s) => s !== "verification" || x.verification) },
    },
  ];
  const concl = x.conclusions.filter((c) => c.text.trim());
  if (concl.length)
    items.push({
      key: `${keyBase}.conclusions`,
      title: `${x.workItem ?? `Run #${x.runId}`} — agent conclusions (${x.repo})`,
      content: [
        "Agent conclusions from a previous task — NOT verified facts. Use as hints only; confirm in the code before relying on them.",
        ...concl.map((c) => `From step "${c.step}":\n${quote(c.text)}`),
      ].join("\n\n"),
      enabled: false,
      meta: { ...base, trust: "unverified" as Trust, confidence: "low" as const, sources: concl.map((c) => `step:${c.step}`) },
    });
  return items;
}

/** Extract memory from a COMPLETED run. Idempotent (existing keys are left untouched). */
export async function extractRunMemory(runId: number) {
  const run = await one(pool, "SELECT r.*, w.code AS wi_code FROM workflow_runs r LEFT JOIN work_items w ON w.id = r.work_item_id WHERE r.id = $1", [runId]);
  if (!run || run.status !== "COMPLETED") return [];
  const steps = await q(pool, "SELECT key, type, output FROM workflow_steps WHERE run_id = $1 ORDER BY position", [runId]);
  const coding = steps.filter((s: any) => s.type === "coding_agent" && s.output);
  const verdict = steps.find((s: any) => s.output?.independent === true)?.output?.verdict ?? null;
  const tests = steps.filter((s: any) => s.type === "command" && s.output && !s.output.skipped);
  const testsPassed = tests.length ? tests.every((s: any) => s.output.passed !== false) : null;
  const conclusions = coding.flatMap((s: any) => [
    { step: s.key, text: String(s.output.summary ?? "") },
    ...((s.output.decisions ?? []) as any[]).map((d) => ({ step: s.key, text: typeof d === "string" ? d : `${d.title ?? ""}: ${d.detail ?? ""}` })),
  ]);
  const written: string[] = [];
  for (const w of await q(pool, "SELECT repo, path FROM execution_workspaces WHERE run_id = $1", [runId])) {
    if (!existsSync(w.path)) continue;
    const sha = await git(w.path, "rev-parse", "HEAD").catch(() => "");
    if (!sha) continue;
    const files = (await git(w.path, "diff", "--name-only", `origin/${config.baseBranch}...HEAD`).catch(() => "")).split("\n").filter(Boolean);
    const items = buildMemoryItems({
      runId, title: run.title, workItem: run.wi_code, repo: w.repo, sha, files,
      verification: coding[0]?.output?.verification, independentVerdict: verdict, testsPassed, conclusions,
    });
    for (const it of items) {
      if (await knowledge.get(it.key)) continue;
      await knowledge.create({
        key: it.key, category: "task_memory", scope_type: "REPOSITORY", scope_ref: w.repo, title: it.title, content: it.content, enabled: it.enabled,
        applicability: { repos: [w.repo] }, metadata: { load: "on_demand", description: it.title, memory: it.meta }, created_by: "memory extraction", change_note: `from run #${runId}`,
      });
      written.push(it.key);
    }
  }
  return written;
}

/** Promote (or reject) an agent-conclusion memory item. Only a human call path reaches this. */
export async function reviewMemory(key: string, decision: "approve" | "reject", by: string) {
  const item = await knowledge.get(key);
  if (!item || item.category !== "task_memory") throw new Error(`memory item "${key}" not found`);
  const meta = item.versions[0]?.metadata ?? {};
  if (!meta.memory) throw new Error(`"${key}" has no memory provenance`);
  if (!by.trim()) throw new Error("approval needs the reviewer's name");
  const memory = { ...meta.memory, trust: decision === "approve" ? "approved" : "rejected", approved_by: by, approved_at: new Date().toISOString() };
  return knowledge.update(key, { enabled: decision === "approve", metadata: { ...meta, memory }, change_note: `${decision}d by ${by}`, created_by: by });
}

const staleCache = new Map<string, boolean>();
/** True when any of the item's files changed on origin/<base> since its commit (or the commit is unknown here). */
export async function isStale(meta: MemoryMeta, repoDir: string): Promise<boolean> {
  if (!meta?.commit_sha || !meta.files?.length) return false;
  const baseSha = await git(repoDir, "rev-parse", `origin/${meta.base_branch || config.baseBranch}`).catch(() => "");
  const k = `${repoDir}|${meta.commit_sha}|${baseSha}|${meta.files.join(",")}`;
  if (staleCache.has(k)) return staleCache.get(k)!;
  let stale: boolean;
  try {
    // Changes on the base branch since the merge-base of the task commit, restricted to the item's files.
    const mb = await git(repoDir, "merge-base", meta.commit_sha, baseSha || `origin/${config.baseBranch}`);
    const changed = await git(repoDir, "diff", "--name-only", mb, baseSha || `origin/${config.baseBranch}`, "--", ...meta.files);
    const sinceTask = await git(repoDir, "diff", "--name-only", meta.commit_sha, baseSha || `origin/${config.baseBranch}`, "--", ...meta.files);
    // merged unchanged → identical files; edited later → differs from the task commit
    stale = !!sinceTask && !!changed;
  } catch {
    stale = true; // commit not present (history rewritten / other clone): cannot vouch for it
  }
  staleCache.set(k, stale);
  return stale;
}
