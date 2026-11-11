import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config, codeIntelligenceEnabled } from "../config.ts";
import { pool, q } from "../db/pool.ts";
import { rankRepositories, type RepositoryRow, type RankedRepository } from "../repos/service.ts";
import { workspacesOf } from "../git/provider.ts";
import { redactSecrets } from "../integrations/redact.ts";
import { effectiveSql, snapshot, type Snapshot } from "./store.ts";
import { baseCommit, changes, git, readSource, eligible, safePath, hash } from "./git.ts";
import { localScope, enqueue } from "./indexer.ts";
const exec = promisify(execFile);
export interface SearchScope {
  repositories: string[];
  allowed: string[];
  runId?: number;
  /** When one run has several worktrees of the same repository, read this checkout rather than the first. */
  workspaces?: Readonly<Record<string, string>>;
  /** Metadata ranking may inspect existing sources but must never provision or schedule clones. */
  provision?: boolean;
}
export interface Hit {
  repository: string;
  file_path: string;
  line_range: [number, number];
  match_type: string;
  confidence: number;
  snapshot: {
    id: number | null;
    commit: string;
    generation: string;
    run_id: number | null;
  };
  symbol_name?: string;
  qualified_name?: string;
  signature?: string;
  snippet?: string;
  content_hash?: string;
}
function authorize(s: SearchScope) {
  if (s.repositories.length > 30 || s.repositories.some((r) => !s.allowed.includes(r)))
    throw new Error("Unauthorized repository search");
}
export const queryTerms = (text: string) =>
  [...new Set(text.match(/[A-Za-z_][A-Za-z0-9_./:-]{2,127}/g) ?? [])].slice(0, 24);
export async function fresh(
  repoName: string,
  runId?: number,
  provision = false,
  workspacePath?: string,
) {
  const local = await localScope(repoName, runId, provision, workspacePath);
  const base = await baseCommit(local.primary, local.repo.default_branch || config.baseBranch);
  const baseline = await snapshot(local.repo.id, `base:${base}`);
  if (!baseline) return { ...local, index: null, base };
  if (!runId) return { ...local, index: baseline, base };
  const state = await changes(local.root, base);
  const index =
    (await snapshot(
      local.repo.id,
      `overlay:${config.instanceId}:${runId}:${baseline.id}:${state.generation}`,
    )) ?? null;
  return { ...local, index, base };
}
const provenance = (s: Snapshot) => ({
  id: s.id,
  commit: s.commit_sha,
  generation: s.generation,
  run_id: s.run_id,
});
async function scopeRun(name: string, scope: SearchScope) {
  if (!scope.runId) return undefined;
  return (await workspacesOf(scope.runId)).some((w) => w.repo === name) ? scope.runId : undefined;
}
/** Only published and freshly validated snapshot mappings are queried. Failure is a live-search fallback. */
export async function searchSymbols(
  text: string,
  scope: SearchScope,
  limit = 30,
): Promise<{ hits: Hit[]; fallback_count: number; search_latency: number }> {
  authorize(scope);
  const start = Date.now(),
    terms = queryTerms(text);
  const hits: Hit[] = [];
  let fallback_count = 0;
  if (!codeIntelligenceEnabled() || !terms.length)
    return { hits, fallback_count, search_latency: Date.now() - start };
  for (const repo of scope.repositories) {
    try {
      const run = await scopeRun(repo, scope);
      const checkout = scope.workspaces?.[repo];
      const f = await fresh(repo, run, scope.provision === true, checkout);
      if (!f.index) {
        fallback_count++;
        if (scope.provision !== false) await enqueue(repo, run).catch(() => {});
        hits.push(
          ...(await searchCodeExact(
            terms[0],
            { ...scope, repositories: [repo] },
            Math.min(5, limit),
          )),
        );
        continue;
      }
      const rows = await q(
        pool,
        `WITH f AS (${effectiveSql}) SELECT f.file_path,s.*,e.content_hash,
        CASE WHEN s.qualified_name=ANY($2) THEN 'qualified' WHEN s.symbol_name=ANY($2) THEN 'exact_symbol' ELSE 'path' END AS match_type
        FROM f JOIN code_intelligence.symbols s ON s.extraction_id=f.extraction_id JOIN code_intelligence.extractions e ON e.id=f.extraction_id
        WHERE s.symbol_name=ANY($2) OR s.qualified_name=ANY($2) OR EXISTS(SELECT 1 FROM unnest($2::text[]) t WHERE position(lower(t) in lower(f.file_path))>0)
        ORDER BY CASE WHEN s.qualified_name=ANY($2) THEN 0 WHEN s.symbol_name=ANY($2) THEN 1 ELSE 2 END,f.file_path,s.start_byte,s.id LIMIT $3`,
        [f.index.id, terms, Math.max(1, limit)],
      );
      const edges = await q(
        pool,
        `WITH f AS (${effectiveSql}) SELECT f.file_path,r.target_name,r.line,e.content_hash FROM f
        JOIN code_intelligence.relations r ON r.extraction_id=f.extraction_id JOIN code_intelligence.extractions e ON e.id=f.extraction_id
        WHERE r.relation_type IN ('IMPORTS','RPC_REQUEST','RPC_RESPONSE') AND EXISTS(SELECT 1 FROM unnest($2::text[]) t WHERE lower(t)=lower(r.target_name) OR lower(t)=lower(regexp_replace(r.target_name,'^.*/','')))
        ORDER BY f.file_path,r.line,r.id LIMIT 8`,
        [f.index.id, terms],
      );
      const recheck = await fresh(repo, run, scope.provision === true, checkout);
      if (recheck.index?.id !== f.index.id) {
        fallback_count++;
        if (scope.provision !== false) await enqueue(repo, run).catch(() => {});
        continue;
      }
      if (!rows.length && !edges.length) {
        fallback_count++;
        const preferred = terms.find((t) => /[a-z][A-Z]|_|[./]/.test(t)) ?? terms[0];
        hits.push(
          ...(await searchCodeExact(
            preferred,
            { ...scope, repositories: [repo] },
            Math.min(5, limit),
          )),
        );
      }
      hits.push(
        ...rows.map((r) => ({
          repository: repo,
          file_path: r.file_path,
          line_range: [r.start_line, r.end_line] as [number, number],
          match_type: r.match_type,
          confidence: r.match_type === "path" ? 0.4 : 0.95,
          snapshot: provenance(f.index!),
          symbol_name: r.symbol_name,
          qualified_name: r.qualified_name,
          signature: r.signature,
          content_hash: r.content_hash,
        })),
      );
      hits.push(
        ...edges.map((r) => ({
          repository: repo,
          file_path: r.file_path,
          line_range: [r.line, r.line] as [number, number],
          match_type: "dependency",
          confidence: 0.4,
          snapshot: provenance(f.index!),
          signature: `syntax reference: ${r.target_name}`,
          content_hash: r.content_hash,
        })),
      );
    } catch {
      fallback_count++;
      try {
        hits.push(
          ...(await searchCodeExact(
            terms[0],
            { ...scope, repositories: [repo] },
            Math.min(5, limit),
          )),
        );
      } catch {
        /* existing agent search remains available */
      }
    }
  }
  return {
    hits: hits
      .sort(
        (a, b) =>
          b.confidence - a.confidence ||
          Number(b.match_type === "qualified") - Number(a.match_type === "qualified") ||
          a.repository.localeCompare(b.repository) ||
          a.file_path.localeCompare(b.file_path) ||
          a.line_range[0] - b.line_range[0],
      )
      .slice(0, limit),
    fallback_count,
    search_latency: Date.now() - start,
  };
}
export async function findDefinitions(symbol: string, scope: SearchScope) {
  const result = await searchSymbols(symbol, scope);
  const isDefinition = (h: Hit) => h.symbol_name === symbol || h.qualified_name === symbol;
  return {
    ...result,
    hits: result.hits.filter(isDefinition),
    // Text matches from a stale/unavailable index are never presented as definitions — but never hidden either.
    text_candidates: result.fallback_count
      ? result.hits.filter((h) => !isDefinition(h) && h.match_type === "text").slice(0, 10)
      : [],
  };
}
/** Syntax edges are preserved as candidates. Name equality never promotes them to resolved calls. */
export async function findDependencies(
  symbol: string,
  scope: SearchScope,
  depth = 1,
  direction: "out" | "in" = "out",
  report?: { unavailable: string[] },
) {
  authorize(scope);
  if (!codeIntelligenceEnabled()) return [];
  const result: any[] = [];
  let frontier = [symbol];
  const seen = new Set<string>();
  for (let d = 0; d < Math.min(3, Math.max(1, depth)) && frontier.length; d++) {
    const next: string[] = [];
    const levelStart = result.length;
    for (const repo of scope.repositories) {
      try {
        const run = await scopeRun(repo, scope);
        const checkout = scope.workspaces?.[repo];
        const f = await fresh(repo, run, scope.provision === true, checkout);
        if (!f.index) {
          if (report && !report.unavailable.includes(repo)) report.unavailable.push(repo);
          continue;
        }
        const rows = await q(
          pool,
          `WITH f AS (${effectiveSql}) SELECT f.file_path,r.*,e.content_hash FROM f JOIN code_intelligence.relations r ON r.extraction_id=f.extraction_id JOIN code_intelligence.extractions e ON e.id=f.extraction_id
          WHERE ${direction === "out" ? "r.source_name" : "r.target_name"}=ANY($2) ORDER BY f.file_path,r.line,r.id LIMIT 50`,
          [
            f.index.id,
            direction === "in"
              ? [...new Set([...frontier, ...frontier.map((n) => n.split(".").pop()!)])]
              : frontier,
          ],
        );
        if ((await fresh(repo, run, scope.provision === true, checkout)).index?.id !== f.index.id) {
          if (report && !report.unavailable.includes(repo))
            report.unavailable.push(`${repo} (index changed during the query)`);
          continue;
        }
        for (const r of rows) {
          const key = `${repo}:${r.file_path}:${r.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          result.push({
            ...r,
            repository: repo,
            snapshot: provenance(f.index),
            line_range: [r.line, r.line],
            match_type: "dependency",
            confidence: r.resolution === "resolved" ? 1 : 0.4,
            depth: d + 1,
          });
          next.push(direction === "out" ? r.target_name : r.source_name);
          if (result.length >= 100) return result;
        }
      } catch (e) {
        /* unavailable repositories are not allowed to interrupt navigation — but are reported */
        if (report && !report.unavailable.includes(repo))
          report.unavailable.push(`${repo} (${(e as Error).message.split("\n")[0].slice(0, 120)})`);
      }
    }
    frontier = [...new Set(next)].slice(0, 24);
    // Batch candidate discovery across the authorized snapshots; matching names are explicitly candidates.
    const candidates = await searchSymbols(
      frontier.map((n) => n.replace(/^\.\//, "")).join(" "),
      scope,
      60,
    );
    for (const edge of result.slice(levelStart)) {
      edge.candidate_definitions = candidates.hits
        .filter(
          (h) =>
            h.symbol_name === edge.target_name ||
            h.qualified_name === edge.target_name ||
            h.file_path === edge.target_name.replace(/^\.\//, "") ||
            h.file_path.endsWith("/" + edge.target_name),
        )
        .slice(0, 5);
    }
    frontier = [
      ...new Set([
        ...frontier,
        ...candidates.hits.map((h) => h.qualified_name).filter((n): n is string => !!n),
      ]),
    ].slice(0, 50);
  }
  return result;
}
export const findReferences = (symbol: string, scope: SearchScope) =>
  findDependencies(symbol, scope, 1, "in");
/** Files an exact text search may read outside the indexed languages (config, logs, docs) — never secret material. */
const SECRET_FILE =
  /(?:^|\/)\.env(?:\.[^/]*)?$|\.(?:pem|key|p12|pfx|jks|keystore)$|(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)|(?:^|\/)[^/]*secret[^/]*$|(?:^|\/)\.npmrc$|(?:^|\/)\.netrc$/i;
export function eligibleText(p: string) {
  const parts = p.split("/");
  return (
    !SECRET_FILE.test(p) &&
    !parts.some((s) => /^(?:\.git|dist|build|coverage)$/.test(s)) &&
    (config.codeIntelligence.includeDependencies ||
      !parts.some((s) => /^(?:node_modules|vendor)$/.test(s))) &&
    !config.codeIntelligence.excludes.some((x) => p.includes(x))
  );
}
/**
 * Bounded ripgrep. Default: the indexed languages only (code fallback). `anyFile`: exact text / config / log search in
 * any non-secret file — Tree-sitter is never forced on strings or unsupported languages.
 */
export async function searchCodeExact(
  pattern: string,
  scope: SearchScope,
  limit = 20,
  opts: { anyFile?: boolean } = {},
): Promise<Hit[]> {
  authorize(scope);
  if (!pattern || pattern.length > 256 || pattern.includes("\n"))
    throw new Error("Invalid exact search pattern");
  const hits: Hit[] = [];
  for (const name of scope.repositories) {
    const run = await scopeRun(name, scope);
    const { root } = await localScope(
      name,
      run,
      scope.provision !== false,
      scope.workspaces?.[name],
    );
    const before = await changes(root, (await git(root, ["rev-parse", "HEAD"])).trim());
    const repositoryHits: Hit[] = [];
    let stdout = "";
    try {
      stdout = (
        await exec(
          "rg",
          [
            "--json",
            "--fixed-strings",
            "--max-count",
            "5",
            "--max-filesize",
            String(config.codeIntelligence.maxFileBytes),
            ...(opts.anyFile
              ? [
                  "--glob",
                  "!**/.env*",
                  "--glob",
                  "!**/*.{pem,key,p12,pfx,jks,keystore}",
                  "--glob",
                  "!**/*secret*",
                  "--glob",
                  "!**/node_modules/**",
                  "--glob",
                  "!**/vendor/**",
                ]
              : ["--glob", "*.{go,ts,tsx,proto,sql}"]),
            "--",
            pattern,
            ".",
          ],
          {
            cwd: root,
            timeout: 3000,
            maxBuffer: 512 * 1024,
            env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
          },
        )
      ).stdout;
    } catch (e) {
      if ((e as any).code === 1) continue;
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("ripgrep unavailable; install rg on the assigned worker");
      throw new Error("Bounded exact search unavailable");
    }
    if ((await changes(root, before.head)).generation !== before.generation) continue;
    for (const line of stdout.split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      if (row.type !== "match") continue;
      const p = row.data.path.text?.replace(/^\.\//, "");
      if (!p || !(opts.anyFile ? eligibleText(p) : eligible(p))) continue;
      safePath(root, p);
      // Read via the same symlink/size checks as indexing; rg never follows symlinks by default.
      const source = await readSource(root, p);
      if (source === null) continue;
      const n = row.data.line_number;
      if (!source.split("\n")[n - 1]?.includes(pattern)) continue;
      repositoryHits.push({
        repository: name,
        file_path: p,
        line_range: [n, n],
        match_type: "text",
        confidence: 0.5,
        snapshot: {
          id: null,
          commit: before.head,
          generation: before.generation,
          run_id: run ?? null,
        },
        snippet: redactSecrets(source.split("\n")[n - 1]?.slice(0, 400) ?? ""),
        content_hash: hash(source),
      });
      if (repositoryHits.length >= limit - hits.length) break;
    }
    if ((await changes(root, before.head)).generation === before.generation)
      hits.push(...repositoryHits);
    if (hits.length >= limit) return hits.slice(0, limit);
  }
  return hits;
}
export function applyEvidence(
  ranked: RankedRepository[],
  hits: Hit[],
  dependencyRepos: Set<string> = new Set(),
) {
  const w = config.codeIntelligence.weights;
  return ranked
    .map((r) => {
      const evidence = hits.filter((h) => h.repository === r.repo);
      // At most one contribution per signal, capped below a strong name/service metadata match.
      const kinds = new Set(evidence.map((h) => h.match_type));
      const bonus = Math.min(
        w.cap,
        (kinds.has("exact_symbol") ? w.exact : 0) +
          (kinds.has("qualified") ? w.qualified : 0) +
          (kinds.has("path") ? w.path : 0) +
          (kinds.has("text") ? w.text : 0) +
          (dependencyRepos.has(r.repo) || kinds.has("dependency") ? w.dependency : 0),
      );
      return {
        ...r,
        score: r.score + bonus,
        reasons: bonus
          ? [
              ...r.reasons,
              `code evidence +${bonus}: ${[...kinds].sort().join(", ")}${dependencyRepos.has(r.repo) ? ", import/dependency candidate" : ""}`,
            ]
          : r.reasons,
      };
    })
    .sort((a, b) => b.score - a.score || a.repo.localeCompare(b.repo));
}
export async function hybridRank(
  repos: RepositoryRow[],
  request: { text: string; keywords?: string[]; project?: string },
) {
  const old = rankRepositories(repos, request);
  if (!codeIntelligenceEnabled()) return old;
  try {
    const scope = {
      repositories: repos.map((r) => r.name).slice(0, 30),
      allowed: repos.map((r) => r.name),
      provision: false,
    };
    const found = await searchSymbols(
      [request.text, ...(request.keywords ?? [])].join(" "),
      scope,
      60,
    );
    const dependencies = new Set<string>();
    // Registry dependencies remain explicit evidence; syntax imports support candidate discovery only.
    for (const r of repos)
      if (r.dependencies.some((d) => found.hits.some((h) => h.repository === d)))
        dependencies.add(r.name);
    return applyEvidence(old, found.hits, dependencies);
  } catch {
    return old;
  }
}
export async function buildCodeContext(text: string, scope: SearchScope) {
  const start = Date.now();
  const result = await searchSymbols(text, scope, 25);
  const parts: string[] = [];
  const localRoots = new Map<string, ReturnType<typeof localScope>>();
  const used = new Map<string, Array<[number, number]>>();
  let remaining = config.codeIntelligence.contextTokens * 4;
  const primary = [...result.hits];
  const qualified = primary
    .map((h) => h.qualified_name)
    .filter((x): x is string => !!x)
    .slice(0, 4);
  const supporting: Hit[] = [];
  for (const name of qualified) {
    const edges = await findDependencies(name, scope, 1);
    for (const edge of edges) supporting.push(...(edge.candidate_definitions ?? []));
    const callers = await findReferences(name, scope);
    for (const edge of callers.slice(0, 3))
      supporting.push({
        repository: edge.repository,
        file_path: edge.file_path,
        line_range: edge.line_range,
        match_type: "caller_candidate",
        confidence: 0.4,
        snapshot: edge.snapshot,
        content_hash: edge.content_hash,
      });
  }
  for (const hit of [...primary, ...supporting]) {
    if (remaining < 200) break;
    try {
      const key = `${hit.repository}:${hit.file_path}:${hit.snapshot.id}:${hit.snapshot.generation}`;
      const ranges = used.get(key) ?? [];
      const [first, last] = hit.line_range;
      const end = Math.min(last, first + 18);
      if (ranges.some(([a, b]) => first <= b && end >= a)) continue;
      const scopeKey = `${hit.repository}:${hit.snapshot.run_id}`;
      const rootPromise =
        localRoots.get(scopeKey) ??
        localScope(
          hit.repository,
          hit.snapshot.run_id ?? undefined,
          false,
          scope.workspaces?.[hit.repository],
        );
      localRoots.set(scopeKey, rootPromise);
      const local = await rootPromise;
      let source: string | null;
      if (hit.snapshot.run_id || hit.snapshot.id === null)
        source = await readSource(local.root, hit.file_path);
      else source = await git(local.root, ["show", `${hit.snapshot.commit}:${hit.file_path}`]);
      if (source === null || hash(source) !== hit.content_hash) continue;
      const block = `${hit.repository}/${hit.file_path}:${first}-${end} commit=${hit.snapshot.commit} worktree_run=${hit.snapshot.run_id ?? "base"} generation=${hit.snapshot.generation}\n${hit.signature ?? ""}\n${redactSecrets(
        source
          .split("\n")
          .slice(first - 1, end)
          .join("\n"),
      )}`;
      const selected = block.slice(0, remaining);
      parts.push(selected);
      remaining -= selected.length + 2;
      ranges.push([first, end]);
      used.set(key, ranges);
    } catch {
      /* source changed or disappeared: skip stale snippet */
    }
  }
  const body = parts.join("\n\n").slice(0, config.codeIntelligence.contextTokens * 4);
  return {
    body,
    hits: primary.slice(0, 10),
    metrics: {
      search_latency: result.search_latency,
      context_latency: Date.now() - start,
      retrieved_context_size: body.length,
      retrieved_context_tokens: Math.ceil(body.length / 4),
      fallback_count: result.fallback_count,
    },
  };
}
