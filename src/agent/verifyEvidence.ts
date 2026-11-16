import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepoVerification } from "./verify.ts";
import { one, q, type Db } from "../db/pool.ts";

/**
 * Verification-evidence reuse (REQ-96). A passed per-repo verification is reused only when EVERY part of a
 * conservative key is equal; any doubt (store error, git error, unknown state) means a real rerun, never a false pass.
 * Failed / error / skipped / timed-out / needs-review / weakened results are never stored as reusable.
 */
const exec = promisify(execFile);

export type EvidenceParts = Record<string, string>;

export interface EvidenceRecord {
  key: string;
  parts: EvidenceParts;
  result: RepoVerification;
  attempt_id: number | null;
  duration_ms: number;
}

export interface EvidenceStore {
  find(scope: EvidenceScope, repo: string, key: string): Promise<EvidenceRecord | null>;
  latest(scope: EvidenceScope, repo: string): Promise<EvidenceRecord | null>;
  save(scope: EvidenceScope, repo: string, rec: EvidenceRecord): Promise<void>;
}

export interface EvidenceScope {
  runId: number;
  stepKey: string;
  attemptId?: number | null;
}

export type EvidenceDecision =
  | { kind: "hit"; key: string; record: EvidenceRecord }
  | { kind: "joined"; key: string; promise: Promise<RepoVerification | null> }
  | { kind: "lead"; key: string; reason: string; parts: EvidenceParts; settle(r: RepoVerification | null): Promise<string | null>; fail(): void };

export interface EvidenceStats {
  hits: number;
  misses: number;
  reused: number;
  duplicates_avoided: number;
  saved_ms: number;
  invalidations: string[];
  not_stored: string[];
}

export const emptyStats = (): EvidenceStats => ({
  hits: 0, misses: 0, reused: 0, duplicates_avoided: 0, saved_ms: 0, invalidations: [], not_stored: [],
});

export const canonicalJson = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1)))
      : val);

export const evidenceKey = (parts: EvidenceParts) =>
  createHash("sha256").update(canonicalJson(parts)).digest("hex");

/** Why a stored result may not be served again; null = reusable. */
export function notReusableReason(r: RepoVerification): string | null {
  if (r.status !== "passed" && r.status !== "accepted_preexisting") return `status ${r.status}`;
  if (r.status === "accepted_preexisting" && r.needs_review) return "accepted_preexisting needs review";
  if (r.needs_review) return "needs review";
  if (r.exit_code !== 0) return "non-zero exit";
  if (r.timed_out) return "timed out";
  if (r.error) return "error";
  if (r.weakened.length) return "tests weakened";
  if (!r.tested_state) return "no tested state";
  return null;
}

/** First differing part between two key part sets (invalidation reason). */
export function firstDifference(prev: EvidenceParts, next: EvidenceParts): string {
  const order = ["head", "workspace_fingerprint", "base_tip", "contract_revision", "command", "selectors",
    "policy", "baseline", "timeout", "env_fingerprint", "env_vars", "skip"];
  const names = [...order, ...Object.keys(next).filter((k) => !order.includes(k))];
  for (const n of names) if ((prev[n] ?? "") !== (next[n] ?? "")) return n;
  return "none_found";
}

const DEP_FILES = ["go.mod", "go.sum", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
  "tsconfig.json", ".golangci.yml", "Makefile", ".nvmrc", ".node-version", ".tool-versions"];

/** Hash of dependency/test-config files (committed or not) plus toolchain versions. Throws when it cannot be established. */
export async function envFingerprint(path: string): Promise<string> {
  const h = createHash("sha256");
  const present: string[] = [];
  for (const f of DEP_FILES) {
    const ok = await exec("git", ["-C", path, "ls-files", "--error-unmatch", f]).then(() => true, () => false);
    const exists = ok || (await import("node:fs/promises").then((fs) => fs.stat(`${path}/${f}`).then(() => true, () => false)));
    if (exists) present.push(f);
  }
  if (present.length) {
    const { stdout } = await exec("git", ["-C", path, "hash-object", "--", ...present]);
    present.forEach((f, i) => h.update(`${f}\0${stdout.split("\n")[i]}\0`));
  }
  h.update(`node ${process.version}\0`);
  const go = await exec("go", ["version"]).then((r) => r.stdout.trim(), () => "no-go");
  h.update(go);
  return h.digest("hex");
}

export async function baseTip(path: string, baseBranch: string | undefined): Promise<string> {
  if (!baseBranch) return "";
  return exec("git", ["-C", path, "rev-parse", `origin/${baseBranch}`]).then((r) => r.stdout.trim(), () => "unknown");
}

/** Process-local singleflight + persisted evidence. One instance per verification loop. */
export class EvidenceCache {
  private inflight = new Map<string, { promise: Promise<RepoVerification | null>; resolve(r: RepoVerification | null): void }>();
  readonly stats = emptyStats();
  readonly store: EvidenceStore;
  readonly scope: EvidenceScope;
  constructor(store: EvidenceStore, scope: EvidenceScope) {
    this.store = store;
    this.scope = scope;
  }

  get pending() { return this.inflight.size; }

  async begin(repo: string, parts: EvidenceParts): Promise<EvidenceDecision> {
    const key = evidenceKey({ ...parts, repo, run: String(this.scope.runId) });
    const flight = `${this.scope.runId}\0${repo}\0${key}`;
    const running = this.inflight.get(flight);
    if (running) {
      this.stats.duplicates_avoided++;
      return { kind: "joined", key, promise: running.promise };
    }
    let rec: EvidenceRecord | null = null;
    let reason = "no_prior_evidence";
    try {
      rec = await this.store.find(this.scope, repo, key);
      if (rec && notReusableReason(rec.result)) rec = null;
      // The state may be taken by a concurrent leader while we awaited the store.
      const again = this.inflight.get(flight);
      if (again) { this.stats.duplicates_avoided++; return { kind: "joined", key, promise: again.promise }; }
      if (rec) {
        this.stats.hits++; this.stats.reused++;
        this.stats.saved_ms += rec.duration_ms;
        return { kind: "hit", key, record: rec };
      }
      const prev = await this.store.latest(this.scope, repo);
      if (prev) reason = firstDifference(prev.parts, { ...parts });
    } catch (e) {
      reason = `store_error: ${(e as Error).message}`.slice(0, 160);
    }
    this.stats.misses++;
    this.stats.invalidations.push(reason);
    let resolve!: (r: RepoVerification | null) => void;
    const promise = new Promise<RepoVerification | null>((res) => (resolve = res));
    this.inflight.set(flight, { promise, resolve });
    let done = false;
    const finish = (r: RepoVerification | null) => {
      if (done) return;
      done = true;
      this.inflight.delete(flight);
      resolve(r);
    };
    return {
      kind: "lead", key, reason, parts,
      fail: () => finish(null),
      settle: async (r) => {
        let why: string | null = r ? notReusableReason(r) : "no result";
        if (r && !why) {
          try {
            await this.store.save(this.scope, repo, { key, parts, result: r, attempt_id: this.scope.attemptId ?? null, duration_ms: r.duration_ms });
          } catch (e) { why = `store_error: ${(e as Error).message}`.slice(0, 160); }
        }
        if (why) this.stats.not_stored.push(why);
        finish(r && !notReusableReason(r) ? r : null);
        return why;
      },
    };
  }
}

type EvidenceRow = { key: string; parts: EvidenceParts; result: RepoVerification; attempt_id?: number | null; duration_ms?: number };

/** PostgreSQL-backed store (migration 059). Rows are scoped by run_id. */
export function pgEvidenceStore(db: Db): EvidenceStore {
  const toRec = (r: EvidenceRow): EvidenceRecord => ({
    key: r.key, parts: r.parts, result: r.result, attempt_id: r.attempt_id ?? null, duration_ms: r.duration_ms ?? 0,
  });
  return {
    async find(s, repo, key) {
      const r = await one(db, "SELECT * FROM verification_evidence WHERE run_id=$1 AND repo=$2 AND key=$3 ORDER BY id DESC LIMIT 1", [s.runId, repo, key]);
      return r ? toRec(r) : null;
    },
    async latest(s, repo) {
      const r = await one(db, "SELECT * FROM verification_evidence WHERE run_id=$1 AND step_key=$2 AND repo=$3 ORDER BY created_at DESC, id DESC LIMIT 1", [s.runId, s.stepKey, repo]);
      return r ? toRec(r) : null;
    },
    async save(s, repo, rec) {
      await q(db, "INSERT INTO verification_evidence (run_id, step_key, attempt_id, repo, key, parts, status, result, duration_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [s.runId, s.stepKey, s.attemptId ?? null, repo, rec.key, JSON.stringify(rec.parts), rec.result.status, JSON.stringify(rec.result), Math.round(rec.duration_ms)]);
    },
  };
}

/** In-memory store (tests, benchmark). */
export function memoryEvidenceStore(): EvidenceStore & { rows: Array<{ scope: EvidenceScope; repo: string; rec: EvidenceRecord }> } {
  const rows: Array<{ scope: EvidenceScope; repo: string; rec: EvidenceRecord }> = [];
  return {
    rows,
    async find(s, repo, key) { return rows.findLast((r) => r.scope.runId === s.runId && r.repo === repo && r.rec.key === key)?.rec ?? null; },
    async latest(s, repo) { return rows.findLast((r) => r.scope.runId === s.runId && r.scope.stepKey === s.stepKey && r.repo === repo)?.rec ?? null; },
    async save(s, repo, rec) { rows.push({ scope: s, repo, rec: structuredClone(rec) }); },
  };
}
