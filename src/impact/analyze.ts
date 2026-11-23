import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pool, q } from "../db/pool.ts";
import { HttpError } from "../http/error.ts";
import { listAccessibleRepositories } from "../repos/access.ts";
import { repositoryBaseBranch } from "../repos/service.ts";
import {
  CONFIG_FILE,
  dynamicSites,
  extractLine,
  MAX_LINE,
  SUPPORTED_SOURCE,
  UNSUPPORTED_SOURCE,
  type Contract,
  type ContractKind,
  type DynamicSite,
} from "./contracts.ts";
import {
  checkoutOf,
  ensureFresh,
  identifierUses,
  testsMentioning,
  type Freshness,
} from "./index.ts";

const exec = promisify(execFile);

/**
 * Change impact across repositories. Input: a repository and a change (unified diff, changed files, or explicit
 * contract keys / symbols). Output: the contracts the change touches, their counterparts in OTHER repositories the
 * actor can read (with file:line@commit evidence), breaking changes, compatibility checks, candidate regression tests
 * and the repositories that need a coordinated update. Inferred links are labelled as such; stale or missing indexes
 * are reported, never treated as complete.
 *
 * Coverage is explicit (`analysis.status`): complete — every changed file was analysable, no changed contract site has
 * a runtime-built key, every searched index is fresh and no counterpart repository has unresolvable sites of a changed
 * kind; partial — some of that is missing (listed in `analysis.limitations`); stale — an index is stale or unavailable;
 * unsupported — nothing in the change could be analysed. An empty impact list is NEVER "no impact": `conclusion` is
 * `impact_found`, `no_static_dependency_found` (complete analysis, still only static/inferred links) or `unknown`.
 */

export interface ImpactRequest {
  repository: string;
  diff?: string;
  files?: string[];
  contracts?: Array<{ kind: ContractKind; key: string }>;
  symbols?: string[];
  /** Compute the diff of this branch against the base branch from the local checkout. */
  branch?: string;
  /** Further restriction of the searched repositories (a workflow run's allowed repositories). */
  allowedRepositories?: string[];
}

interface Row {
  repo: string;
  commit: string;
  kind: ContractKind;
  role: "provider" | "consumer";
  key: string;
  method: string | null;
  access: string | null;
  file: string;
  line: number;
  snippet: string;
  confidence: "static" | "inferred";
}

interface Hunk {
  file: string;
  removed: Array<{ line: number; text: string }>;
  added: Array<{ line: number; text: string }>;
}
/** Largest diff analysed (bytes); bigger changes are refused rather than parsed for minutes. */
export const MAX_DIFF_BYTES = 512 * 1024;
/**
 * Unified diff → hunks. File headers (`--- a/`, `+++ b/`, `/dev/null` for created/deleted files) are only read in a
 * file's header block (after `diff --git`, before its first `@@`), so a removed line whose text is `-- a/x` stays content.
 * Overlong lines are skipped (generated code), which also bounds the recognisers' cost.
 */
function hunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  let file = "";
  let cur: Hunk | null = null;
  let header = false;
  let oldN = 0,
    newN = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      header = true;
      cur = null;
      file = raw.match(/ b\/(.+)$/)?.[1] ?? "";
      continue;
    }
    if (header || !cur) {
      const minus = raw.match(/^--- (?:a\/(.+)|\/dev\/null)$/);
      const plus = raw.match(/^\+\+\+ (?:b\/(.+)|\/dev\/null)$/);
      if (minus) {
        if (minus[1]) file = minus[1];
        continue;
      }
      if (plus) {
        if (plus[1]) file = plus[1];
        continue;
      }
    }
    const at = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (at) {
      header = false;
      oldN = Number(at[1]);
      newN = Number(at[2]);
      cur = { file, removed: [], added: [] };
      out.push(cur);
      continue;
    }
    if (!cur || header) continue;
    if (raw.length > MAX_LINE + 1) {
      if (raw.startsWith("-")) oldN++;
      else if (raw.startsWith("+")) newN++;
      else {
        oldN++;
        newN++;
      }
      continue;
    }
    if (raw.startsWith("-")) cur.removed.push({ line: oldN++, text: raw.slice(1) });
    else if (raw.startsWith("+")) cur.added.push({ line: newN++, text: raw.slice(1) });
    else if (!raw.startsWith("\\")) {
      oldN++;
      newN++;
    }
  }
  return out;
}

const STATE_WORDS =
  /\b(?:status|state|transition)\b|(?:Status|State)[A-Z_]|[A-Z]+_(?:STATUS|STATE)_/;
const DOMAIN =
  /payment|refund|settle|authori[sz]|captur|order|shipment|shipping|delivery|fulfil|(?:^|\/)pay(?:[/_-]|$)/i;

export interface BreakingChange {
  kind: ContractKind | "schema" | "state_transition";
  key: string;
  file: string;
  line: number;
  reason: string;
  confidence: "static" | "inferred";
}

/** Breaking-change detectors over a diff (removals and incompatible edits, not additions). */
export function breakingChanges(diff: string): {
  changed: Contract[];
  removedContracts: Contract[];
  breaking: BreakingChange[];
} {
  const changed: Contract[] = [];
  const removedContracts: Contract[] = [];
  const breaking: BreakingChange[] = [];
  const all = hunks(diff);
  const ctxOf = (list: Array<{ text: string }>, i: number) =>
    list.slice(Math.max(0, i - 3), i).map((x) => x.text);
  // Contracts are compared across the WHOLE diff: code moved to another hunk or file is not a removal.
  const removedAll = all.flatMap((h) =>
    h.removed.flatMap((r, i) => extractLine(h.file, r.line, r.text, ctxOf(h.removed, i))),
  );
  const addedAll = all.flatMap((h) =>
    h.added.flatMap((a, i) => extractLine(h.file, a.line, a.text, ctxOf(h.added, i))),
  );
  changed.push(...removedAll, ...addedAll);
  const same = (a: Contract, c: Contract) =>
    a.kind === c.kind &&
    a.key === c.key &&
    a.role === c.role &&
    (a.method ?? "") === (c.method ?? "");
  for (const c of removedAll)
    if (!addedAll.some((a) => same(a, c))) {
      removedContracts.push(c);
      if (c.role === "provider") {
        const replacements = addedAll.filter(
          (a) => a.kind === c.kind && a.role === "provider" && !removedAll.some((r) => same(r, a)),
        );
        breaking.push({
          kind: c.kind,
          key: c.key,
          file: c.file,
          line: c.line,
          reason: `${c.kind} ${c.method ? `${c.method} ` : ""}${c.key} is no longer provided${
            replacements.length
              ? ` (replaced by ${replacements.map((a) => `${a.method ? `${a.method} ` : ""}${a.key}`).join(", ")})`
              : ""
          }`,
          confidence: c.confidence,
        });
      }
    }
  const addedTexts = new Set(all.flatMap((h) => h.added.map((a) => a.text.trim())));
  for (const h of all) {
    // Protobuf: removed or renumbered fields, removed enum values.
    if (h.file.endsWith(".proto")) {
      const field = /^\s*(?:repeated\s+|optional\s+)?([\w.]+)\s+(\w+)\s*=\s*(\d+)/;
      const enumValue = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(\d+)\s*;/;
      for (const r of h.removed) {
        const f = r.text.match(field);
        if (f && !/^\s*(rpc|reserved|option)\b/.test(r.text)) {
          const twin = h.added.map((a) => a.text.match(field)).find((a) => a && a[2] === f[2]);
          if (!twin)
            breaking.push({
              kind: "schema",
              key: f[2],
              file: h.file,
              line: r.line,
              reason: `protobuf field ${f[2]} (=${f[3]}) removed`,
              confidence: "static",
            });
          else if (twin[3] !== f[3] || twin[1] !== f[1])
            breaking.push({
              kind: "schema",
              key: f[2],
              file: h.file,
              line: r.line,
              reason: `protobuf field ${f[2]} changed ${f[1]}=${f[3]} → ${twin[1]}=${twin[3]} (wire-incompatible)`,
              confidence: "static",
            });
        }
        const e = r.text.match(enumValue);
        if (e && !h.added.some((a) => a.text.match(enumValue)?.[1] === e[1]))
          breaking.push({
            kind: "shared_enum",
            key: e[1],
            file: h.file,
            line: r.line,
            reason: `enum value ${e[1]} removed`,
            confidence: "static",
          });
      }
    }
    // SQL schema: drops, renames, type changes, NOT NULL without default.
    for (const a of h.added) {
      const t = a.text;
      const table = t
        .match(/\b(?:ALTER|DROP)\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?(?:\w+\.)?(\w+)/i)?.[1]
        ?.toLowerCase();
      if (!table) continue;
      const why = /\bDROP\s+TABLE\b/i.test(t)
        ? "table dropped"
        : /\bDROP\s+COLUMN\b/i.test(t)
          ? "column dropped"
          : /\bRENAME\b/i.test(t)
            ? "table or column renamed"
            : /\bALTER\s+COLUMN\b.*\bTYPE\b/i.test(t)
              ? "column type changed"
              : /\bSET\s+NOT\s+NULL\b/i.test(t) ||
                  (/\bADD\s+COLUMN\b.*\bNOT\s+NULL\b/i.test(t) && !/\bDEFAULT\b/i.test(t))
                ? "NOT NULL without a default (writers must change)"
                : null;
      if (why)
        breaking.push({
          kind: "db_table",
          key: table,
          file: h.file,
          line: a.line,
          reason: why,
          confidence: "static",
        });
    }
    // Event payloads: a JSON field removed from a file that produces a topic (inferred: the struct may not be the event).
    const jsonTag = /json:"([\w-]+)[,"]/;
    for (const r of h.removed) {
      const tag = r.text.match(jsonTag)?.[1];
      if (tag && !all.some((x) => x.added.some((a) => a.text.match(jsonTag)?.[1] === tag)))
        breaking.push({
          kind: "schema",
          key: tag,
          file: h.file,
          line: r.line,
          reason: `serialized field "${tag}" removed`,
          confidence: "inferred",
        });
    }
    // State transitions of payment/order/shipment: any edit of a status/state line is a semantic risk to review.
    // (proto enums are covered by the enum rule above.)
    for (const r of h.file.endsWith(".proto") ? [] : h.removed)
      if (
        STATE_WORDS.test(r.text) &&
        (DOMAIN.test(r.text) || DOMAIN.test(h.file)) &&
        !addedTexts.has(r.text.trim())
      )
        breaking.push({
          kind: "state_transition",
          key: r.text.trim().slice(0, 80),
          file: h.file,
          line: r.line,
          reason: "payment/order/shipment state logic changed: verify consumers of the state",
          confidence: "inferred",
        });
  }
  return { changed, removedContracts, breaking };
}

/** Repositories the actor may read now (the same check as chat's readableRepositories: effective grants). */
export async function readableOf(actorId: number) {
  return (await listAccessibleRepositories(actorId)).map((r) => r.repository.name);
}

export async function analyzeImpact(actorId: number, req: ImpactRequest) {
  const t0 = Date.now();
  const all = await readableOf(actorId);
  const readable = req.allowedRepositories
    ? all.filter((r) => req.allowedRepositories!.includes(r))
    : all;
  if (!readable.includes(req.repository))
    throw new HttpError(403, "repository not found or not accessible");
  let diff = req.diff ?? "";
  if (!diff && req.branch) {
    if (!/^[\w][\w./-]{0,199}$/.test(req.branch) || req.branch.includes(".."))
      throw new HttpError(400, "invalid branch");
    const path = await checkoutOf(req.repository);
    if (!path) throw new HttpError(409, "repository has no local checkout");
    const base = await repositoryBaseBranch(req.repository);
    const opts = { maxBuffer: MAX_DIFF_BYTES + 1024, timeout: 30_000 };
    diff = await exec(
      "git",
      ["-C", path, "diff", "--no-color", `origin/${base}...${req.branch}`],
      opts,
    )
      .catch(() => exec("git", ["-C", path, "diff", "--no-color", `${base}...${req.branch}`], opts))
      .then((r) => r.stdout)
      .catch(() => {
        throw new HttpError(400, "branch not found or diff too large");
      });
  }
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES)
    throw new HttpError(
      413,
      `diff too large (max ${MAX_DIFF_BYTES / 1024} KB): pass changed files instead`,
    );
  // Fresh indexes for the source and every readable repository (bounded re-extraction; the rest reported stale).
  const { freshness, reindexed } = await ensureFresh([
    req.repository,
    ...readable.filter((r) => r !== req.repository),
  ]);
  const { changed, removedContracts, breaking } = breakingChanges(diff);
  const parsed = hunks(diff);
  const files = [...new Set([...(req.files ?? []), ...parsed.map((h) => h.file)])].filter(Boolean);
  // Contract sites in the change whose key is built at runtime: never joined, always reported.
  const dynamic: DynamicSite[] = [];
  for (const h of parsed)
    for (const l of [...h.removed, ...h.added])
      if (dynamic.length < 50) dynamic.push(...dynamicSites(h.file, l.line, l.text));
  // Contracts declared in the changed files (file-level: the change may alter their payload without touching the key).
  const touched = files.length
    ? await q<Row>(pool, "SELECT * FROM impact_contracts WHERE repo=$1 AND file = ANY($2)", [
        req.repository,
        files,
      ])
    : [];
  const subject = new Map<
    string,
    { kind: ContractKind; key: string; role: string | null; method: string | null; via: string }
  >();
  const addSubject = (
    kind: ContractKind,
    key: string,
    role: string | null,
    method: string | null,
    via: string,
  ) => {
    const k = `${kind}|${key}|${role ?? ""}`;
    if (!subject.has(k)) subject.set(k, { kind, key, role, method, via });
  };
  for (const c of changed) addSubject(c.kind, c.key, c.role, c.method ?? null, "diff");
  for (const c of touched) addSubject(c.kind, c.key, c.role, c.method, "changed file");
  for (const c of req.contracts ?? []) addSubject(c.kind, c.key, null, null, "request");
  for (const b of breaking)
    if (b.kind === "db_table") addSubject("db_table", b.key, "provider", null, "schema change");
  // Protobuf field/enum changes affect consumers of every service/enum declared in that proto file.
  for (const b of breaking.filter((x) => x.kind === "schema" || x.kind === "shared_enum"))
    for (const c of touched.filter((t) => t.file === b.file && t.role === "provider"))
      addSubject(c.kind, c.key, "provider", null, "schema change");

  const others = readable.filter((r) => r !== req.repository);
  const impacts: Array<{
    repo: string;
    kind: ContractKind;
    key: string;
    relation: string;
    confidence: "static" | "inferred";
    evidence: Array<{ file: string; line: number; commit: string; snippet: string; side: string }>;
    breaking: string[];
  }> = [];
  for (const s of subject.values()) {
    // A provider change affects consumers; a consumer change depends on providers; tables: every other user of the table.
    const roles =
      s.kind === "db_table"
        ? ["consumer", "provider"]
        : s.role === "provider"
          ? ["consumer"]
          : s.role === "consumer"
            ? ["provider"]
            : ["consumer", "provider"];
    const rows = others.length
      ? await q<Row>(
          pool,
          "SELECT * FROM impact_contracts WHERE kind=$1 AND key=$2 AND role = ANY($3) AND repo = ANY($4) ORDER BY repo,file,line LIMIT 200",
          [s.kind, s.key, roles, others],
        )
      : [];
    const source =
      touched.find((t) => t.kind === s.kind && t.key === s.key) ??
      changed.find((c) => c.kind === s.kind && c.key === s.key);
    const byRepo = new Map<string, Row[]>();
    for (const r of rows) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r]);
    for (const [repo, group] of byRepo) {
      const matching = group.filter((r) => !s.method || !r.method || r.method === s.method);
      if (!matching.length) continue;
      const breaks = breaking.filter(
        (b) =>
          (b.kind === s.kind && b.key === s.key) ||
          (b.kind !== s.kind && b.kind !== "state_transition" && source && b.file === source.file),
      );
      impacts.push({
        repo,
        kind: s.kind,
        key: s.key,
        relation: `${req.repository} ${s.role ?? "uses"} → ${repo} ${matching[0].role}${s.kind === "db_table" && matching[0].access ? ` (${matching[0].access})` : ""}`,
        // A link is static only when both ends are literal extractions.
        confidence:
          matching.every((m) => m.confidence === "static") &&
          (!source || ("confidence" in source && source.confidence === "static"))
            ? "static"
            : "inferred",
        evidence: [
          ...(source
            ? [
                {
                  file: source.file,
                  line: source.line,
                  commit: "commit" in source ? String(source.commit) : "diff",
                  snippet: source.snippet,
                  side: req.repository,
                },
              ]
            : []),
          ...matching.slice(0, 10).map((m) => ({
            file: m.file,
            line: m.line,
            commit: m.commit,
            snippet: m.snippet,
            side: repo,
          })),
        ],
        breaking: breaks.map((b) => b.reason),
      });
    }
  }
  // Changed shared identifiers (explicit symbols, removed enums): inferred uses in other repositories.
  const identifiers = [
    ...new Set([
      ...(req.symbols ?? []),
      ...breaking.filter((b) => b.kind === "shared_enum").map((b) => b.key),
    ]),
  ].slice(0, 20);
  for (const id of identifiers)
    for (const repo of others) {
      const uses = await identifierUses(repo, id, 10);
      if (uses.length)
        impacts.push({
          repo,
          kind: "shared_enum",
          key: id,
          relation: `${repo} references ${id}`,
          confidence: "inferred",
          evidence: uses.map((u) => ({ ...u, side: repo })),
          breaking: breaking.filter((b) => b.key === id).map((b) => b.reason),
        });
    }
  const coordinated = [...new Set(impacts.filter((i) => i.breaking.length).map((i) => i.repo))];
  const tests: Record<string, string[]> = {};
  for (const repo of [req.repository, ...new Set(impacts.map((i) => i.repo))]) {
    const keys = [
      ...new Set([
        ...impacts.filter((i) => i.repo === repo || repo === req.repository).map((i) => i.key),
      ]),
    ];
    const found = await testsMentioning(repo, keys);
    if (found.length) tests[repo] = found;
  }
  const checks = [
    ...impacts
      .filter((i) => i.breaking.length)
      .map(
        (i) =>
          `${i.repo}: ${i.kind} ${i.key} — ${i.breaking[0]}; update or make the consumer tolerant before deploying (expand/contract)`,
      ),
    ...[...new Set(impacts.filter((i) => i.kind === "kafka_topic").map((i) => i.key))].map(
      (k) =>
        `Kafka ${k}: replay a recorded event with the new producer against every consumer (schema compatibility)`,
    ),
    ...[...new Set(impacts.filter((i) => i.kind === "http_route").map((i) => i.key))].map(
      (k) => `HTTP ${k}: run consumer contract tests against the changed provider`,
    ),
    ...(breaking.some((b) => b.kind === "state_transition")
      ? [
          "State transitions changed: verify every consumer of the state machine (allowed transitions, idempotency)",
        ]
      : []),
  ];
  const fresh = Object.values(freshness);
  // ---- coverage: what this analysis could NOT see
  const config = files.filter((f) => CONFIG_FILE.test(f));
  const unsupported = files.filter((f) => UNSUPPORTED_SOURCE.test(f));
  const analysable = files.filter((f) => SUPPORTED_SOURCE.test(f));
  const changedKinds = new Set<string>([...subject.values()].map((x) => x.kind));
  for (const d of dynamic) changedKinds.add(d.kind);
  const blindCounterparts = fresh
    .filter((f) => f.repo !== req.repository)
    .flatMap((f) =>
      Object.entries(f.dynamic_sites ?? {})
        .filter(([kind, n]) => n > 0 && changedKinds.has(kind))
        .map(([kind, n]) => ({ repo: f.repo, kind, sites: n })),
    );
  const staleRepos = fresh.filter((f) => f.stale || !f.available);
  const limitations: string[] = [];
  if (dynamic.length)
    limitations.push(
      `${dynamic.length} changed contract site(s) build their key at runtime (${[...new Set(dynamic.map((d) => d.reason))].join("; ")}): counterparts cannot be matched`,
    );
  if (config.length)
    limitations.push(
      `${config.length} configuration file(s) changed (${config.slice(0, 5).join(", ")}): keys defined in configuration are not analysed`,
    );
  if (unsupported.length)
    limitations.push(
      `${unsupported.length} file(s) in a language without contract recognisers (${unsupported.slice(0, 5).join(", ")})`,
    );
  if (blindCounterparts.length)
    limitations.push(
      `counterpart repositories with runtime-keyed sites of a changed kind: ${blindCounterparts
        .slice(0, 8)
        .map((b) => `${b.repo} (${b.sites} ${b.kind})`)
        .join(", ")}`,
    );
  if (staleRepos.length)
    limitations.push(
      `stale or unavailable indexes: ${staleRepos
        .slice(0, 8)
        .map((f) => `${f.repo}${f.reason ? ` (${f.reason})` : ""}`)
        .join(", ")}`,
    );
  if (!diff && files.length)
    limitations.push("only file names were given: removed or renamed contracts cannot be detected");
  const nothingAnalysable =
    !analysable.length && !(req.contracts?.length || req.symbols?.length) && files.length > 0;
  const status: "complete" | "partial" | "stale" | "unsupported" = nothingAnalysable
    ? "unsupported"
    : staleRepos.length
      ? "stale"
      : limitations.length
        ? "partial"
        : "complete";
  const conclusion = impacts.length
    ? "impact_found"
    : status === "complete"
      ? "no_static_dependency_found"
      : "unknown";
  // Causal memory of the affected code (the actor's own verified outcomes and failed approaches), token-bounded.
  const { recallCausal } = await import("../memory/causal.ts");
  const memories = await recallCausal(actorId, {
    repositories: [req.repository, ...coordinated],
    files,
    text: [...subject.values()].map((s) => s.key).join(" "),
    limit: 3,
    tokenBudget: 300,
  }).catch(() => ({ items: [], tokens_estimate: 0 }));
  return {
    repository: req.repository,
    changed_contracts: [...subject.values()],
    removed_contracts: removedContracts,
    breaking,
    impacts,
    coordinated_repositories: coordinated,
    regression_tests: tests,
    compatibility_checks: [...new Set(checks)].slice(0, 30),
    freshness: fresh,
    partial: {
      stale: fresh.filter((f) => f.stale).map((f) => f.repo),
      unavailable: fresh
        .filter((f) => !f.available)
        .map((f: Freshness) => ({ repo: f.repo, reason: f.reason ?? "unavailable" })),
      // Index freshness only; whether the ANALYSIS is complete is `analysis.status`.
      complete: fresh.every((f) => !f.stale && f.available),
    },
    analysis: {
      status,
      limitations,
      dynamic_sites: dynamic.slice(0, 20),
      blind_counterparts: blindCounterparts.slice(0, 20),
      files: {
        analysed: analysable.length,
        configuration: config,
        unsupported,
      },
    },
    conclusion,
    conclusion_note:
      conclusion === "impact_found"
        ? "dependencies found; others may exist where keys are built at runtime"
        : conclusion === "no_static_dependency_found"
          ? "no static or inferred dependency found; dependencies through runtime-built keys, reflection or external configuration are not excluded"
          : "unknown: the analysis was incomplete, so finding nothing is not evidence of no impact",
    related_memories: memories.items,
    metrics: { latency_ms: Date.now() - t0, repositories: fresh.length, reindexed },
    note: "Static links join literal keys on both sides; inferred links come from naming conventions or identifiers and need confirmation. Repositories you cannot read are not searched.",
  };
}
