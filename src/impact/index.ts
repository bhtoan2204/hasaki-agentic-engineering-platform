import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { pool, q, one, withTx } from "../db/pool.ts";
import { repositories, repositoryBaseBranch } from "../repos/service.ts";
import { resolveRepoPath } from "../repos/paths.ts";
import {
  EXTRACTOR_VERSION,
  GREP_PATTERN,
  SOURCE_PATHSPECS,
  dynamicSites,
  extractLine,
  parseGrep,
} from "./contracts.ts";

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

/** The local checkout of a registered repository, or null (not cloned on this instance). */
export async function checkoutOf(name: string) {
  const repo = await repositories.get(name);
  if (!repo) return null;
  const path = resolveRepoPath(repo);
  return existsSync(path) ? path : null;
}

/** The repository's base commit: origin/<base> when fetched, else the local base branch, else HEAD. */
export async function baseCommit(path: string, base: string) {
  for (const ref of [`origin/${base}`, base, "HEAD"]) {
    const r = await exec(
      "git",
      ["-C", path, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      {
        timeout: 10_000,
      },
    ).catch(() => null);
    const sha = r?.stdout.trim();
    if (sha && /^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  return null;
}

export interface Freshness {
  repo: string;
  indexed_commit: string | null;
  current_commit: string | null;
  stale: boolean;
  available: boolean;
  reason?: string;
  /** Runtime-keyed contract sites per kind at the indexed commit (cannot be joined). */
  dynamic_sites?: Record<string, number>;
}

export async function freshnessOf(name: string): Promise<Freshness> {
  const path = await checkoutOf(name);
  const state = await one<{
    commit: string;
    extractor: string;
    dynamic_sites: Record<string, number>;
  }>(pool, "SELECT commit, extractor, dynamic_sites FROM impact_index_state WHERE repo=$1", [name]);
  if (!path)
    return {
      repo: name,
      indexed_commit: state?.commit ?? null,
      current_commit: null,
      stale: !state,
      available: false,
      reason: "no local checkout",
      dynamic_sites: state?.dynamic_sites ?? {},
    };
  const current = await baseCommit(path, await repositoryBaseBranch(name));
  return {
    repo: name,
    indexed_commit: state?.commit ?? null,
    current_commit: current,
    stale: !state || state.commit !== current || state.extractor !== EXTRACTOR_VERSION,
    available: !!current,
    dynamic_sites: state?.dynamic_sites ?? {},
  };
}

/**
 * Extract the contracts of one repository at its base commit (git grep over the commit: no checkout or worktree is
 * touched) and replace its rows atomically. Skipped when that commit was already extracted by this extractor version.
 */
const inflight = new Map<string, Promise<IndexResult>>();
/** Repositories whose extraction failed recently: not retried on every request (backoff). */
const failedAt = new Map<string, number>();
const FAILURE_BACKOFF_MS = 10 * 60_000;
type IndexResult = {
  repo: string;
  skipped?: string;
  commit?: string;
  contracts: number;
  files?: number;
  ms?: number;
};

/** One extraction per repository at a time in this process (concurrent callers share it). */
export function indexRepository(
  name: string,
  opts: { force?: boolean } = {},
): Promise<IndexResult> {
  const running = inflight.get(name);
  if (running) return running;
  const p = extract(name, opts).finally(() => inflight.delete(name));
  inflight.set(name, p);
  return p;
}

async function extract(name: string, opts: { force?: boolean }): Promise<IndexResult> {
  const f = await freshnessOf(name);
  if (!f.available || !f.current_commit)
    return { repo: name, skipped: f.reason ?? "unavailable", contracts: 0 };
  if (!f.stale && !opts.force) return { repo: name, skipped: "fresh", contracts: 0 };
  const path = (await checkoutOf(name))!;
  const t0 = Date.now();
  const rev = f.current_commit;
  const r = await exec(
    "git",
    [
      "-C",
      path,
      "grep",
      "-n",
      "-z",
      "-I",
      "-E",
      "-B3",
      "-e",
      GREP_PATTERN,
      rev,
      "--",
      ...SOURCE_PATHSPECS,
    ],
    { timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
  ).catch((e: { code?: number; stdout?: string }) =>
    e.code === 1 ? { stdout: "" } : Promise.reject(e),
  );
  const matches = parseGrep(rev, r.stdout);
  const contracts = matches.flatMap((m) => extractLine(m.file, m.line, m.text, m.context));
  const dynamic: Record<string, number> = {};
  for (const m of matches)
    for (const d of dynamicSites(m.file, m.line, m.text, m.context))
      dynamic[d.kind] = (dynamic[d.kind] ?? 0) + 1;
  const files = new Set(contracts.map((c) => c.file)).size;
  const written = await withTx(async (db) => {
    // Serialise writers of this repository across instances; a writer that lost the race sees the state already
    // at this commit and leaves it (no interleaved DELETE/INSERT, no duplicate rows).
    await q(db, "SELECT pg_advisory_xact_lock(hashtext($1))", [`impact:${name}`]);
    const state = await one<{ commit: string; extractor: string }>(
      db,
      "SELECT commit, extractor FROM impact_index_state WHERE repo=$1",
      [name],
    );
    if (!opts.force && state?.commit === rev && state.extractor === EXTRACTOR_VERSION) return false;
    await q(db, "DELETE FROM impact_contracts WHERE repo=$1", [name]);
    for (let i = 0; i < contracts.length; i += 500) {
      const chunk = contracts.slice(i, i + 500);
      await q(
        db,
        `INSERT INTO impact_contracts(repo,commit,kind,role,key,method,access,file,line,snippet,confidence,extractor)
         SELECT $1,$2,x.kind,x.role,x.key,x.method,x.access,x.file,x.line,x.snippet,x.confidence,$3
           FROM jsonb_to_recordset($4::jsonb) AS x(kind text, role text, key text, method text, access text, file text, line int, snippet text, confidence text)`,
        [name, rev, EXTRACTOR_VERSION, JSON.stringify(chunk)],
      );
    }
    await q(
      db,
      `INSERT INTO impact_index_state(repo,commit,extractor,contracts,files,duration_ms,dynamic_sites) VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(repo) DO UPDATE SET commit=$2,extractor=$3,contracts=$4,files=$5,duration_ms=$6,dynamic_sites=$7,indexed_at=now()`,
      [
        name,
        rev,
        EXTRACTOR_VERSION,
        contracts.length,
        files,
        Date.now() - t0,
        JSON.stringify(dynamic),
      ],
    );
    return true;
  });
  if (!written) return { repo: name, skipped: "fresh", contracts: 0 };
  return { repo: name, commit: rev, contracts: contracts.length, files, ms: Date.now() - t0 };
}

/** Error text without server paths or command lines. */
const safeReason = (e: unknown) =>
  String((e as Error)?.message ?? e)
    .split("\n")[0]
    .replace(/Command failed:.*$/, "git command failed")
    .replace(/\/[^\s'"]+/g, "<path>")
    .slice(0, 160);

/**
 * Bring the given repositories up to date, re-extracting at most `maxReindex` stale ones per call (the rest are
 * reported stale, never silently treated as current). Fresh repositories cost one rev-parse each; a repository whose
 * extraction failed is not retried for FAILURE_BACKOFF_MS; one broken registry entry never fails the whole analysis.
 */
export async function ensureFresh(names: string[], maxReindex = 3) {
  const freshness: Record<string, Freshness> = {};
  let reindexed = 0;
  for (const name of names) {
    let f: Freshness;
    try {
      f = await freshnessOf(name);
    } catch (e) {
      freshness[name] = {
        repo: name,
        indexed_commit: null,
        current_commit: null,
        stale: true,
        available: false,
        reason: safeReason(e),
      };
      continue;
    }
    const backoff = Date.now() - (failedAt.get(name) ?? 0) < FAILURE_BACKOFF_MS;
    if (f.stale && f.available && reindexed < maxReindex && !backoff) {
      try {
        await indexRepository(name);
        failedAt.delete(name);
        reindexed++;
        f = await freshnessOf(name);
      } catch (e) {
        failedAt.set(name, Date.now());
        f = { ...f, reason: `extraction failed: ${safeReason(e)}` };
      }
    } else if (f.stale && backoff)
      f = { ...f, reason: "extraction failed recently; retried later" };
    freshness[name] = f;
  }
  return { freshness, reindexed };
}

/** Background refresh of every registered repository's index: the same bounded batch as an analysis, without needing one. */
export async function refreshStaleIndexes(maxReindex = 3) {
  const names = (await repositories.list()).map((r) => r.name);
  return ensureFresh(names, maxReindex);
}

/** Test files of a repository (at its indexed commit) that mention a contract key: candidate regression tests. */
export async function testsMentioning(name: string, keys: string[], limit = 10) {
  const path = await checkoutOf(name);
  const state = await one<{ commit: string }>(
    pool,
    "SELECT commit FROM impact_index_state WHERE repo=$1",
    [name],
  );
  if (!path || !state || !keys.length) return [];
  const args = ["-C", path, "grep", "-l", "-I", "-F"];
  for (const k of keys.slice(0, 10)) args.push("-e", k);
  args.push(
    state.commit,
    "--",
    "*_test.go",
    "*.test.*",
    "*.spec.*",
    "*_test.py",
    "test_*.py",
    "*/test_*.py",
    "*Test.java",
    "*/__tests__/*",
  );
  const r = await exec("git", args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }).catch(
    (e: { code?: number }) => (e.code === 1 ? { stdout: "" } : { stdout: "" }),
  );
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(state.commit.length + 1))
    .slice(0, limit);
}

/** Files of other repositories that reference a shared identifier (inferred dependency on a changed symbol). */
export async function identifierUses(name: string, identifier: string, limit = 20) {
  const path = await checkoutOf(name);
  const state = await one<{ commit: string }>(
    pool,
    "SELECT commit FROM impact_index_state WHERE repo=$1",
    [name],
  );
  if (!path || !state || !/^[A-Za-z_]\w{2,}$/.test(identifier)) return [];
  const r = await exec(
    "git",
    [
      "-C",
      path,
      "grep",
      "-n",
      "-I",
      "-w",
      "-F",
      "-e",
      identifier,
      state.commit,
      "--",
      ...SOURCE_PATHSPECS.filter((p) => !p.endsWith(".proto")),
    ],
    { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
  ).catch(() => ({ stdout: "" }));
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .slice(0, limit)
    .map((l) => {
      const m = l.slice(state.commit.length + 1).match(/^(.+?):(\d+):(.*)$/);
      return m
        ? {
            file: m[1],
            line: Number(m[2]),
            snippet: m[3].trim().slice(0, 200),
            commit: state.commit,
          }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
}

export async function contractsOf(name: string) {
  return q(
    pool,
    "SELECT kind,role,key,method,access,file,line,snippet,confidence,commit FROM impact_contracts WHERE repo=$1 ORDER BY kind,key,file,line LIMIT 2000",
    [name],
  );
}
