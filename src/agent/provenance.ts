/**
 * Evidence provenance, verified by the platform where it can be — never taken from the agent's own `verified` flag.
 *
 *   VERIFIED_BY_PLATFORM  the cited source exists as cited: the commit is in the repository, the file exists at that
 *                         commit, the line range is inside the file and the file is unchanged since (`verifies:
 *                         "location"`); or the cited tool call / artifact is a record of THIS run (`"source_record"`).
 *                         It proves the citation, NOT that the statement about it is true.
 *   AGENT_REPORTED        the agent says it verified it, but the source is not something the platform can check
 *                         (free-text references: a log line, a ticket, a conversation).
 *   UNVERIFIED            no checkable source, a source outside this run's repositories, no commit identity, or the
 *                         file changed since the cited commit (stale: the claim may be outdated).
 *   CONTRADICTED          platform data contradicts the citation: unknown commit, file absent at that commit, lines
 *                         beyond the end of the file, or a tool call / artifact id that this run never produced.
 *
 * Claims are never deleted: an unverifiable or contradicted claim is kept, its `verification_status` lowered so that
 * root-cause and gate decisions cannot rest on it, and the reason recorded in `provenance`.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.ts";
import { one, pool } from "../db/pool.ts";
import { workspacesOf } from "../git/provider.ts";
import { repoPath, repositories, repositoryBaseBranch } from "../repos/service.ts";
import { normalizeScopePath } from "./scopeGuard.ts";

const exec = promisify(execFile);

export const PROVENANCE_STATUSES = ["VERIFIED_BY_PLATFORM", "AGENT_REPORTED", "UNVERIFIED", "CONTRADICTED"] as const;
export type ProvenanceStatus = (typeof PROVENANCE_STATUSES)[number];
export interface Provenance {
  by: "platform";
  status: ProvenanceStatus;
  /** What a VERIFIED_BY_PLATFORM result actually proves. */
  verifies: "location" | "source_record" | null;
  reason: string | null;
  stale?: boolean;
}

export interface ProvenanceEnv {
  /** Local path of a repository this run may read (worktree first), or null when it is not authorized/available. */
  repoPath(repo: string): Promise<string | null>;
  /** Ref the cited file is compared with for staleness (worktree HEAD / origin/<base>), or null to skip. */
  currentRef(repo: string): Promise<string | null>;
  /** Tool call of THIS run by id (null = no such record). */
  toolCall(id: number): Promise<{ status: string } | null>;
  /** Artifact of THIS run by id. */
  artifact(id: number): Promise<boolean>;
}

const mark = (status: ProvenanceStatus, reason: string | null, verifies: Provenance["verifies"] = null, extra: Partial<Provenance> = {}): Provenance => ({ by: "platform", status, verifies, reason, ...extra });
const SHA = /^[0-9a-f]{7,40}$/i;

async function git(path: string, args: string[]) {
  return (await exec("git", ["-C", path, ...args], { maxBuffer: 32 << 20 })).stdout;
}

/** Platform reference syntax for records: tool_call:<id> / tool:<id> / artifact:<id> / artifact_id:<id>. */
export function parseRecordRef(ref: unknown): { kind: "tool_call" | "artifact"; id: number } | null {
  const m = String(ref ?? "").trim().match(/^(tool_call|tool|artifact|artifact_id)\s*[:#]\s*(\d{1,18})$/i);
  if (!m) return null;
  return { kind: /^tool/i.test(m[1]) ? "tool_call" : "artifact", id: Number(m[2]) };
}

export async function verifyClaimProvenance(raw: any, env: ProvenanceEnv): Promise<Provenance> {
  const agentVerified = String(raw?.verification_status ?? "").toLowerCase() === "verified";
  const file = raw?.file_path;
  if (file) {
    const repo = String(raw?.repository ?? "").trim();
    if (!repo) return mark("UNVERIFIED", "file cited without a repository");
    const n = normalizeScopePath(file, repo);
    if ("invalid" in n) return mark("UNVERIFIED", `file path not checkable: ${n.invalid}`);
    const path = await env.repoPath(repo);
    if (!path) return mark("UNVERIFIED", `repository ${repo} is not available to this run`);
    const commit = String(raw?.commit ?? "").trim();
    if (!commit) return mark("UNVERIFIED", "no commit: the location cannot be bound to a revision");
    if (!SHA.test(commit)) return mark("UNVERIFIED", `"${commit.slice(0, 40)}" is not a commit id`);
    const full = await git(path, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]).then((s) => s.trim()).catch(() => "");
    if (!full) return mark("CONTRADICTED", `commit ${commit.slice(0, 12)} does not exist in ${repo}`);
    const content = await git(path, ["show", `${full}:${n.path}`]).catch(() => null);
    if (content === null) return mark("CONTRADICTED", `${n.path} does not exist at ${full.slice(0, 12)}`);
    const range = String(raw?.line_range ?? "").trim();
    if (range) {
      const m = range.match(/^L?(\d+)(?:\s*[-–:]\s*L?(\d+))?$/i);
      if (!m) return mark("UNVERIFIED", `line range "${range.slice(0, 40)}" is not checkable`);
      const lines = content.length ? content.split("\n").length - (content.endsWith("\n") ? 1 : 0) : 0;
      const a = Number(m[1]);
      const b = Number(m[2] ?? m[1]);
      if (a < 1 || b < a || b > lines) return mark("CONTRADICTED", `lines ${a}-${b} are outside ${n.path} at ${full.slice(0, 12)} (${lines} lines)`);
    }
    const ref = await env.currentRef(repo);
    if (ref) {
      const changed = await git(path, ["diff", "--quiet", full, ref, "--", n.path]).then(() => false).catch((e) => (e?.code === 1 ? true : null));
      if (changed === true) return mark("UNVERIFIED", `${n.path} changed between the cited ${full.slice(0, 12)} and ${ref}: the claim may be outdated`, null, { stale: true });
    }
    return mark("VERIFIED_BY_PLATFORM", null, "location");
  }
  const rec = parseRecordRef(raw?.source_ref);
  if (rec) {
    if (rec.kind === "tool_call") {
      const t = await env.toolCall(rec.id);
      if (!t) return mark("CONTRADICTED", `tool call ${rec.id} is not a record of this run`);
      if (t.status !== "ok") return mark("UNVERIFIED", `tool call ${rec.id} ended ${t.status}`);
      return mark("VERIFIED_BY_PLATFORM", null, "source_record");
    }
    if (!(await env.artifact(rec.id))) return mark("CONTRADICTED", `artifact ${rec.id} is not a record of this run`);
    return mark("VERIFIED_BY_PLATFORM", null, "source_record");
  }
  if (agentVerified && raw?.source_ref) return mark("AGENT_REPORTED", "the cited source is not a platform record; only the agent vouches for it");
  return mark("UNVERIFIED", raw?.source_ref ? "the cited source is not a platform record" : "no checkable source");
}

/** Strip any agent-supplied provenance, attach the platform's, and lower `verification_status` where it cannot hold. */
export function applyProvenance(raw: any, p: Provenance) {
  const c = typeof raw === "string" ? { claim: raw } : { ...(raw ?? {}) };
  delete c.provenance;
  const st = String(c.verification_status ?? "").toLowerCase();
  if (p.status === "CONTRADICTED") c.verification_status = "contradicted";
  else if (p.status === "UNVERIFIED" && st === "verified") c.verification_status = "unverified";
  c.provenance = p;
  return c;
}

/** Verify every claim of an agent output (bounded); failures of the check itself leave the claim UNVERIFIED. */
export async function withProvenance(claims: unknown, env: ProvenanceEnv) {
  if (!Array.isArray(claims)) return claims;
  const list = claims.slice(0, 60);
  const marks = await Promise.all(list.map((c) => verifyClaimProvenance(typeof c === "string" ? { claim: c } : c, env).catch((e) => mark("UNVERIFIED", `provenance check failed: ${(e as Error).message.split("\n")[0].slice(0, 160)}`))));
  return list.map((c, i) => applyProvenance(c, marks[i]));
}

/** The environment of one run: its worktrees and allowed repositories, its tool calls and artifacts only. */
export async function runProvenanceEnv(run: { id: number; allowed_repositories: string[] }): Promise<ProvenanceEnv> {
  const ws = new Map((await workspacesOf(run.id).catch(() => [])).map((w) => [w.repo, w.path]));
  return {
    async repoPath(repo) {
      if (ws.has(repo)) return ws.get(repo)!;
      if (!run.allowed_repositories.includes(repo)) return null;
      const registered = await repositories.get(repo).catch(() => null);
      if (!registered) return null;
      try {
        return repoPath(registered);
      } catch {
        return null;
      }
    },
    async currentRef(repo) {
      if (ws.has(repo)) return "HEAD";
      return `origin/${await repositoryBaseBranch(repo).catch(() => config.baseBranch)}`;
    },
    toolCall: (id) => one<{ status: string }>(pool, "SELECT status FROM agent_context_tool_calls WHERE id = $1 AND run_id = $2", [id, run.id]).then((r) => r ?? null),
    artifact: async (id) => !!(await one(pool, "SELECT 1 FROM workflow_artifacts WHERE id = $1 AND run_id = $2", [id, run.id])),
  };
}
