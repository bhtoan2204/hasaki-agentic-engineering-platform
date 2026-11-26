import { config } from "../config.ts";
import { pool, q, one, withTx, json, type Db } from "../db/pool.ts";
import { HttpError } from "../http/error.ts";
import { log } from "../logging.ts";
import { repoPath, repositories } from "../repos/service.ts";
import { countMemoryAging, setActiveTaskMemory } from "../runtimeMetrics.ts";
import {
  decide,
  kindOf,
  overCap,
  purge,
  thresholdsFrom,
  unknownIsPermanent,
  type AgingItem,
  type AgingState,
  type AgingThresholds,
  type Decision,
  type ObservationRef,
  type OperationRef,
  type UnknownCode,
} from "./agingPolicy.ts";
import {
  memoryFreshnessIn,
  provenanceProblem,
  repoFreshnessContext,
  type MemoryMeta,
} from "./memory.ts";
import { knowledge } from "./service.ts";

/**
 * Task memory aging (docs/architecture/memory-aging.md): load, decide with the pure policies, apply, audit.
 * Deterministic (no model), reversible (archive = disabled + a reason; hard delete only long after), multi-instance
 * safe (claims under an advisory lock, every apply is a guarded short transaction), bounded (batch, concurrency and
 * a time budget) and never inside a transaction that runs git.
 */

/** Advisory-lock class of the claim step (two int4 keys: class, phase). */
const LOCK_CLASS = 4_218_001;
const RUN_MEMORY_KEY = "^memory\\.run-[0-9]+\\..+\\.(facts|conclusions)$";

const intOr = (raw: string | undefined, fallback: number, min = 1) => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isInteger(n) && n >= min ? n : fallback;
};
export const agingEnabled = () =>
  !["false", "0", "off"].includes((config.memoryAging.enabled ?? "").trim().toLowerCase());
export const agingSettings = () => ({
  intervalMs: intOr(config.memoryAging.intervalMinutes, 60) * 60_000,
  batchSize: intOr(config.memoryAging.batchSize, 200),
  concurrency: intOr(config.memoryAging.concurrency, 4),
  budgetMs: intOr(config.memoryAging.budgetSeconds, 60) * 1000,
  thresholds: thresholdsFrom(config.memoryAging as Partial<Record<keyof AgingThresholds, string>>),
});

export interface AgingOptions {
  /** Report what would happen; change nothing (no claims, no unknown-state tracking, no writes). */
  dryRun?: boolean;
  ownerId?: number;
  repo?: string;
  now?: Date;
  /** Freshness is re-checked for items not checked in the last interval; 0 = every item (CLI). */
  intervalMs?: number;
  batchSize?: number;
  budgetMs?: number;
}
export interface AgingAction {
  key: string;
  ownerId: number | null;
  repo: string;
  action: Decision["action"];
  policy: Decision["policy"];
  reason: string;
  replacedBy?: string;
  applied: boolean;
}
export interface AgingReport {
  dryRun: boolean;
  examined: number;
  freshnessChecked: number;
  actions: AgingAction[];
  /** Permanent UNKNOWN sightings recorded (or, in a dry run, that would be recorded). */
  unknownTracked: number;
  stoppedByBudget: boolean;
  /** Another instance held the claim lock for the whole pass. */
  contended: boolean;
  ms: number;
}

// ------------------------------------------------------------------ loading

interface Row {
  id: number;
  key: string;
  owner_id: number | null;
  scope_ref: string;
  enabled: boolean;
  current_version: number;
  created_at: Date;
  updated_at: Date;
  memory: Record<string, unknown> | null;
  state: AgingState | null;
  pinned: boolean | null;
  state_at: Date | null;
  policy: string | null;
  unknown_since: Date | null;
  unknown_code: string | null;
  last_loaded_at: Date | null;
}

const toItem = (r: Row): AgingItem | null => {
  const memory = r.memory ?? {};
  const kind = kindOf(r.key, memory);
  if (!kind) return null;
  return {
    id: Number(r.id),
    key: r.key,
    ownerId: r.owner_id == null ? null : Number(r.owner_id),
    repo:
      kind === "chat_preference" || kind === "chat_procedure"
        ? ""
        : String(memory.repo ?? r.scope_ref ?? ""),
    kind,
    enabled: r.enabled,
    currentVersion: Number(r.current_version),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    trust: typeof memory.trust === "string" ? memory.trust : null,
    memory,
    state: r.state ?? "active",
    pinned: r.pinned ?? false,
    stateAt: r.state_at,
    policy: r.policy,
    unknownSince: r.unknown_since,
    unknownCode: r.unknown_code,
    lastLoadedAt: r.last_loaded_at,
  };
};

async function loadItems(db: Db, f: { ownerId?: number; repo?: string }) {
  const rows = await q<Row>(
    db,
    `SELECT i.id, i.key, i.owner_id, i.scope_ref, i.enabled, i.current_version, i.created_at, i.updated_at,
            v.metadata->'memory' AS memory, a.state, a.pinned, a.at AS state_at, a.policy, a.unknown_since, a.unknown_code,
            u.last_loaded_at
       FROM knowledge_items i
       JOIN knowledge_versions v ON v.item_id = i.id AND v.version = i.current_version
       LEFT JOIN knowledge_aging a ON a.item_id = i.id
       LEFT JOIN knowledge_usage u ON u.item_id = i.id
      WHERE i.category = 'task_memory' AND ($1::bigint IS NULL OR i.owner_id = $1) AND ($2::text IS NULL OR i.scope_ref = $2)
      ORDER BY i.id`,
    [f.ownerId ?? null, f.repo ?? null],
  );
  return rows.map(toItem).filter((i): i is AgingItem => i !== null);
}

async function loadObservations(db: Db, items: AgingItem[]) {
  const lessons = items.filter((i) => i.kind === "lesson");
  if (!lessons.length) return new Map<string, ObservationRef[]>();
  const since = new Date(
    Math.min(
      ...lessons.map(
        (i) => Date.parse(String(i.memory.extracted_at ?? "")) || i.createdAt.getTime(),
      ),
    ),
  );
  const rows = await q<{
    kind: string;
    run_id: number | null;
    repo: string | null;
    observed_at: Date;
  }>(
    db,
    `SELECT kind, run_id, repo, observed_at FROM outcome_observations
      WHERE kind IN ('regression_reported', 'rollback_reported') AND observed_at > $1`,
    [since],
  );
  const filesOfRun = new Map<string, string[]>();
  for (const i of items)
    if (i.kind === "facts" && Array.isArray(i.memory.files))
      filesOfRun.set(`${i.memory.run_id}|${i.repo}`, i.memory.files as string[]);
  const byRepo = new Map<string, ObservationRef[]>();
  for (const r of rows)
    for (const repo of new Set(lessons.map((l) => l.repo)))
      if (r.repo === null || r.repo === repo)
        byRepo.set(repo, [
          ...(byRepo.get(repo) ?? []),
          {
            kind: r.kind,
            runId: r.run_id == null ? null : Number(r.run_id),
            repo: r.repo,
            observedAt: r.observed_at,
            files: filesOfRun.get(`${r.run_id}|${repo}`) ?? [],
          },
        ]);
  return byRepo;
}

/** For each learned procedure: the latest finished run of the same operation (owner, tool, target). */
async function loadOperations(db: Db, items: AgingItem[]) {
  const ids = items
    .filter((i) => i.kind === "chat_procedure" && Number.isInteger(Number(i.memory.operation_id)))
    .map((i) => Number(i.memory.operation_id));
  const out = new Map<number, OperationRef>();
  if (!ids.length) return out;
  const rows = await q<{ op_id: number; status: string; finished_at: Date | null }>(
    db,
    `SELECT o.id AS op_id, l.status, l.finished_at
       FROM chat_operations o
       JOIN LATERAL (SELECT x.status, x.finished_at FROM chat_operations x
                      WHERE x.owner_id = o.owner_id AND x.tool = o.tool AND x.target = o.target AND x.status IN ('succeeded', 'failed')
                      ORDER BY x.finished_at DESC NULLS LAST, x.id DESC LIMIT 1) l ON true
      WHERE o.id = ANY($1)`,
    [ids],
  );
  for (const r of rows) out.set(Number(r.op_id), { status: r.status, finishedAt: r.finished_at });
  return out;
}

// ------------------------------------------------------------------ claiming (the only multi-instance coordination)

/**
 * Run memory whose freshness this pass should look at: the least recently examined first. Claiming marks them
 * (`checked_at`) under a try-advisory lock, so another instance skips them instead of checking them again; the lock is
 * released at commit, long before git runs.
 */
async function nextForFreshness(
  n: number,
  f: { ownerId?: number; repo?: string; intervalMs: number; passStart: Date; claim: boolean },
) {
  const select = async (c: Db) =>
    (
      await q<{ id: number }>(
        c,
        `SELECT i.id FROM knowledge_items i LEFT JOIN knowledge_aging a ON a.item_id = i.id
          WHERE i.category = 'task_memory' AND i.enabled AND i.key ~ $5
            AND coalesce(a.state, 'active') NOT IN ('archived', 'superseded') AND coalesce(a.pinned, false) = false
            AND ($1::bigint IS NULL OR i.owner_id = $1) AND ($2::text IS NULL OR i.scope_ref = $2)
            AND (a.checked_at IS NULL OR (a.checked_at < now() - make_interval(secs => $3) AND a.checked_at < $4))
          ORDER BY a.checked_at NULLS FIRST, i.id LIMIT $6`,
        [f.ownerId ?? null, f.repo ?? null, f.intervalMs / 1000, f.passStart, RUN_MEMORY_KEY, n],
      )
    ).map((r) => Number(r.id));
  if (!f.claim) return { ids: await select(pool), contended: false };
  return withTx(async (c) => {
    const lock = await one<{ locked: boolean }>(
      c,
      "SELECT pg_try_advisory_xact_lock($1, 1) AS locked",
      [LOCK_CLASS],
    );
    if (!lock?.locked) return { ids: [] as number[], contended: true };
    const ids = await select(c);
    if (ids.length)
      await q(
        c,
        "INSERT INTO knowledge_aging (item_id, checked_at) SELECT unnest($1::bigint[]), now() ON CONFLICT (item_id) DO UPDATE SET checked_at = now()",
        [ids],
      );
    return { ids, contended: false };
  });
}

// ------------------------------------------------------------------ freshness (git, no connection held)

type Examined = {
  freshness: { state: string; reason: string } | null;
  unknown: { code: UnknownCode; permanent: boolean } | null;
};

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
    }),
  );
  return out;
}

/** Freshness of run memory. The repository-level facts (base SHA, last fetch) are computed once per repository and base. */
async function examine(items: AgingItem[], concurrency: number): Promise<Map<number, Examined>> {
  const out = new Map<number, Examined>();
  const workers = new Map<number, string | null>();
  const runIds = [...new Set(items.map((i) => Number(i.memory.run_id)).filter(Number.isInteger))];
  if (runIds.length)
    for (const r of await q<{ id: number; worker_instance: string | null }>(
      pool,
      "SELECT id, worker_instance FROM workflow_runs WHERE id = ANY($1)",
      [runIds],
    ))
      workers.set(Number(r.id), r.worker_instance);
  const repos = new Map<string, ReturnType<typeof repositories.get>>();
  const contexts = new Map<string, ReturnType<typeof repoFreshnessContext>>();
  const unknown = (code: UnknownCode, onInstance: boolean | null): Examined => ({
    freshness: null,
    unknown: { code, permanent: unknownIsPermanent(code, onInstance) },
  });
  await mapLimit(items, concurrency, async (item) => {
    const problem = provenanceProblem(item.memory as Partial<MemoryMeta>);
    if (problem) return void out.set(item.id, unknown(problem.code as UnknownCode, null));
    if (!repos.has(item.repo)) repos.set(item.repo, repositories.get(item.repo));
    const repo = await repos.get(item.repo);
    if (!repo) return void out.set(item.id, unknown("repo_unregistered", null));
    const base = String(item.memory.base_branch ?? "");
    const ck = `${item.repo}|${base}`;
    if (!contexts.has(ck)) contexts.set(ck, repoFreshnessContext(repoPath(repo), base));
    const ctx = await contexts.get(ck)!;
    if ("result" in ctx)
      return void out.set(item.id, unknown(ctx.result.code as UnknownCode, null));
    const r = await memoryFreshnessIn(ctx.context, item.memory as Partial<MemoryMeta>);
    if (r.state === "FRESH") return void out.set(item.id, { freshness: r, unknown: null });
    if (r.state === "STALE") return void out.set(item.id, { freshness: r, unknown: null });
    const worker = workers.get(Number(item.memory.run_id));
    out.set(
      item.id,
      unknown(r.code as UnknownCode, worker == null ? null : worker === config.instanceId),
    );
  });
  return out;
}

// ------------------------------------------------------------------ applying

const actionName: Record<Decision["action"], string> = {
  archive: "archived",
  supersede: "superseded",
  dormant: "dormant",
  restore: "restored",
  purge: "purged",
};

async function audit(
  c: Db,
  item: { id: number | null; key: string; ownerId: number | null },
  action: string,
  detail: Record<string, unknown>,
) {
  await q(
    c,
    "INSERT INTO knowledge_audit (item_id, item_key, owner_id, action, detail) VALUES ($1, $2, $3, $4, $5)",
    [item.id, item.key, item.ownerId, action, json({ ...detail, at: new Date().toISOString() })],
  );
}

/**
 * One decision, one short transaction. It is refused (false) when the item changed since it was read — a new version,
 * a person's pin, another instance's decision — so a stale decision never overrides a newer fact.
 */
async function apply(
  item: AgingItem,
  d: Decision,
  tracking: { since: Date | null; code: string | null } | null,
): Promise<boolean> {
  const done = await withTx(async (c) => {
    // Lock the item first, then read its aging row in a new statement: a concurrent pass that committed while we
    // waited for the lock is then visible (a join would still show the state from before the wait).
    const row = await one<{ enabled: boolean; current_version: number }>(
      c,
      "SELECT enabled, current_version FROM knowledge_items WHERE id = $1 FOR UPDATE",
      [item.id],
    );
    const aging = row
      ? await one<{ state: AgingState; pinned: boolean }>(
          c,
          "SELECT state, pinned FROM knowledge_aging WHERE item_id = $1",
          [item.id],
        )
      : null;
    const cur = row && { ...row, state: aging?.state ?? null, pinned: aging?.pinned ?? false };
    if (!cur || Number(cur.current_version) !== item.currentVersion || cur.pinned) return false;
    const state = cur.state ?? "active";
    if (d.action === "purge") {
      if (state !== "archived" && state !== "superseded") return false;
      await audit(c, item, "purged", {
        policy: d.policy,
        reason: d.reason,
        state,
        by: "memory aging",
      });
      await knowledge.remove(
        item.key,
        { ownerId: item.ownerId, by: "memory aging", reason: d.reason },
        c,
      );
      return true;
    }
    if (state === "archived" || state === "superseded") return false;
    if (d.action === "dormant") {
      if (state === "dormant") return false;
      await q(
        c,
        `INSERT INTO knowledge_aging (item_id, state, policy, reason, at) VALUES ($1, 'dormant', $2, $3, now())
         ON CONFLICT (item_id) DO UPDATE SET state = 'dormant', policy = $2, reason = $3, at = now()`,
        [item.id, d.policy, d.reason],
      );
    } else {
      let successor: number | null = null;
      if (d.action === "supersede") {
        successor =
          (
            await one<{ id: number }>(
              c,
              "SELECT id FROM knowledge_items WHERE key = $1 AND owner_id IS NOT DISTINCT FROM $2 AND enabled",
              [d.replacedBy, item.ownerId],
            )
          )?.id ?? null;
        if (successor == null) return false;
      }
      if (cur.enabled || d.action === "supersede")
        await q(
          c,
          d.action === "supersede"
            ? "UPDATE knowledge_items SET enabled = false, superseded_by = $2, superseded_at = now(), updated_at = now() WHERE id = $1"
            : "UPDATE knowledge_items SET enabled = false, updated_at = now() WHERE id = $1",
          d.action === "supersede" ? [item.id, successor] : [item.id],
        );
      await q(
        c,
        `INSERT INTO knowledge_aging (item_id, state, policy, reason, replaced_by_key, at, unknown_since, unknown_code)
         VALUES ($1, $2, $3, $4, $5, now(), NULL, NULL)
         ON CONFLICT (item_id) DO UPDATE SET state = $2, policy = $3, reason = $4, replaced_by_key = $5, at = now(),
                                             unknown_since = NULL, unknown_code = NULL`,
        [
          item.id,
          d.action === "supersede" ? "superseded" : "archived",
          d.policy,
          d.reason,
          d.replacedBy ?? null,
        ],
      );
    }
    await audit(c, item, actionName[d.action], {
      state:
        d.action === "supersede" ? "superseded" : d.action === "archive" ? "archived" : "dormant",
      policy: d.policy,
      reason: d.reason,
      replaced_by: d.replacedBy ?? null,
      by: "memory aging",
    });
    return true;
  });
  if (done) countMemoryAging(d.policy, d.action);
  if (!done && tracking) await trackUnknown(item, tracking);
  return done;
}

async function trackUnknown(item: AgingItem, t: { since: Date | null; code: string | null }) {
  await q(
    pool,
    `INSERT INTO knowledge_aging (item_id, unknown_since, unknown_code) VALUES ($1, $2, $3)
     ON CONFLICT (item_id) DO UPDATE SET unknown_since = $2, unknown_code = $3`,
    [item.id, t.since, t.code],
  );
}

// ------------------------------------------------------------------ the pass

export async function runMemoryAging(opts: AgingOptions = {}): Promise<AgingReport> {
  const started = Date.now();
  const s = agingSettings();
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? new Date();
  const budgetMs = opts.budgetMs ?? s.budgetMs;
  const batchSize = opts.batchSize ?? s.batchSize;
  const intervalMs = opts.intervalMs ?? s.intervalMs;
  const report: AgingReport = {
    dryRun,
    examined: 0,
    freshnessChecked: 0,
    actions: [],
    unknownTracked: 0,
    stoppedByBudget: false,
    contended: false,
    ms: 0,
  };
  const passStart = (await one<{ t: Date }>(pool, "SELECT now() AS t"))!.t;

  const all = await loadItems(pool, opts);
  report.examined = all.length;
  const observations = await loadObservations(pool, all);
  const operations = await loadOperations(pool, all);
  const ctxFor = (item: AgingItem) => ({
    now,
    thresholds: s.thresholds,
    all,
    observations: observations.get(item.repo) ?? [],
    latestOperation: operations.get(Number(item.memory.operation_id)) ?? null,
  });

  const settle = async (
    item: AgingItem,
    d: Decision,
    tracking: { since: Date | null; code: string | null } | null,
  ) => {
    const entry: AgingAction = {
      key: item.key,
      ownerId: item.ownerId,
      repo: item.repo,
      action: d.action,
      policy: d.policy,
      reason: d.reason,
      replacedBy: d.replacedBy,
      applied: false,
    };
    report.actions.push(entry);
    // The in-memory copy follows the decision, so later policies (replacement, cap) see the same picture a re-run would.
    const apply_ = dryRun ? true : await apply(item, d, tracking);
    entry.applied = !dryRun && apply_;
    if (apply_) {
      if (d.action === "dormant") item.state = "dormant";
      else if (d.action === "purge") all.splice(all.indexOf(item), 1);
      else item.state = d.action === "supersede" ? "superseded" : "archived";
      item.stateAt = now;
      item.policy = d.policy;
    }
  };

  // Phase A: run memory whose freshness is looked at this pass (git, no connection held), decided with it.
  const byId = new Map(all.map((i) => [i.id, i]));
  const checked = new Set<number>();
  const sub = Math.max(1, s.concurrency * 4);
  const deadline = started + budgetMs;
  while (checked.size < batchSize) {
    if (Date.now() >= deadline) {
      report.stoppedByBudget = true;
      break;
    }
    const next = await nextForFreshness(Math.min(sub, batchSize - checked.size), {
      ...opts,
      intervalMs,
      passStart,
      claim: !dryRun,
    });
    if (next.contended) report.contended = true;
    const fresh = next.ids.filter((id) => !checked.has(id));
    if (!fresh.length) break;
    const items = fresh.map((id) => byId.get(id)).filter((i): i is AgingItem => !!i);
    fresh.forEach((id) => checked.add(id));
    // Only memory a prompt could load needs a freshness proof; unapproved conclusions are judged by age alone.
    const provable = items.filter((i) => i.trust === "verified" || i.trust === "approved");
    const results = await examine(provable, s.concurrency);
    report.freshnessChecked += provable.length;
    for (const item of items) {
      const r = results.get(item.id);
      const out = decide(item, {
        ...ctxFor(item),
        freshness: r?.freshness ?? null,
        unknown: r ? r.unknown : undefined,
      });
      const tracking = r ? { since: out.unknownSince, code: out.unknownCode } : null;
      if (out.decision) await settle(item, out.decision, tracking);
      else if (
        r &&
        (out.unknownSince?.getTime() ?? null) !== (item.unknownSince?.getTime() ?? null)
      ) {
        if (out.unknownSince) report.unknownTracked++;
        if (!dryRun) await trackUnknown(item, { since: out.unknownSince, code: out.unknownCode });
      }
    }
  }

  // Phases B and C look at every item with no git: one instance per interval does them (the others skip, a dry run always does).
  const pure = dryRun || (await claimPurePass(intervalMs, passStart));

  // Phase B: every other item, by the policies that need no git.
  for (const item of pure ? [...all] : []) {
    if (checked.has(item.id) || item.state === "archived" || item.state === "superseded") continue;
    const { decision } = decide(item, ctxFor(item));
    if (decision) await settle(item, decision, null);
  }

  // Phase C: the cap over what is still active, then the purge of what has been archived long enough.
  const capped = pure ? overCap(all, s.thresholds.capPerRepo) : new Map<number, Decision>();
  for (const item of pure ? [...all] : []) {
    const d = capped.get(item.id);
    if (d && item.state !== "archived" && item.state !== "superseded") await settle(item, d, null);
  }
  for (const item of pure ? [...all] : []) {
    const d = purge(item, now, s.thresholds);
    if (d) await settle(item, d, null);
  }

  if (!dryRun) await publishActiveGauge(all);
  report.ms = Date.now() - started;
  return report;
}

/**
 * Cluster-wide "who does the git-free policies this interval": a single upsert that only one instance wins
 * (`settings` keeps the time of the last winner). Instances that lose still did their share of the freshness claims.
 */
async function claimPurePass(intervalMs: number, passStart: Date) {
  const won = await one(
    pool,
    `INSERT INTO settings (key, value) VALUES ('memory_aging.pure_pass', $1)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE settings.value::timestamptz < $2 RETURNING key`,
    [passStart.toISOString(), new Date(passStart.getTime() - intervalMs).toISOString()],
  );
  return !!won;
}

async function publishActiveGauge(all: AgingItem[]) {
  const byOwner: Record<string, number> = {};
  for (const i of all)
    if (i.enabled && i.state !== "archived" && i.state !== "superseded")
      byOwner[String(i.ownerId ?? "shared")] = (byOwner[String(i.ownerId ?? "shared")] ?? 0) + 1;
  setActiveTaskMemory(byOwner);
}

let lastPass = 0;
/** The reconcile-tick entry point: at most one pass per interval and process. */
export async function runMemoryAgingThrottled(now = Date.now()) {
  if (!agingEnabled()) return null;
  const s = agingSettings();
  if (now - lastPass < s.intervalMs) return null;
  lastPass = now;
  const report = await runMemoryAging({});
  if (report.actions.length || report.stoppedByBudget)
    log.info(
      `memory aging: ${report.actions.filter((a) => a.applied).length} change(s), ${report.freshnessChecked} freshness check(s)${report.stoppedByBudget ? ", stopped by the time budget" : ""}`,
    );
  return report;
}
/** Tests: let the next pass run at once. */
export const resetMemoryAgingThrottle = () => void (lastPass = 0);

// ------------------------------------------------------------------ restore (a person, or the procedure rule)

export async function restoreMemory(
  key: string,
  ownerId: number | null,
  by: string,
  opts: { auto?: boolean } = {},
) {
  return withTx(async (c) => {
    const item = await one<{ id: number; enabled: boolean }>(
      c,
      "SELECT id, enabled FROM knowledge_items WHERE key = $1 AND owner_id IS NOT DISTINCT FROM $2 AND category = 'task_memory' FOR UPDATE",
      [key, ownerId],
    );
    if (!item) throw new HttpError(404, "memory item not found");
    const aging = await one<{ state: AgingState; policy: string | null }>(
      c,
      "SELECT state, policy FROM knowledge_aging WHERE item_id = $1 FOR UPDATE",
      [item.id],
    );
    if (!aging || !["archived", "superseded", "dormant"].includes(aging.state))
      throw new HttpError(409, "this memory item is not archived");
    const meta = (
      await one<{ memory: Record<string, unknown> | null }>(
        c,
        "SELECT v.metadata->'memory' AS memory FROM knowledge_items i JOIN knowledge_versions v ON v.item_id = i.id AND v.version = i.current_version WHERE i.id = $1",
        [item.id],
      )
    )?.memory;
    // Agent conclusions come back only through approval: a restore must not make unverified text loadable.
    const needsApproval = kindOf(key, meta ?? {}) === "conclusions" && meta?.trust !== "approved";
    await q(
      c,
      `UPDATE knowledge_items SET enabled = $2, superseded_by = CASE WHEN $3 THEN NULL ELSE superseded_by END,
              superseded_at = CASE WHEN $3 THEN NULL ELSE superseded_at END, updated_at = now() WHERE id = $1`,
      [item.id, !needsApproval, aging.state === "superseded"],
    );
    await q(
      c,
      `UPDATE knowledge_aging SET state = 'restored', pinned = $2, reason = $3, replaced_by_key = NULL, at = now(),
              unknown_since = NULL, unknown_code = NULL WHERE item_id = $1`,
      [item.id, !opts.auto, opts.auto ? "procedure succeeded again" : `restored by ${by}`],
    );
    await audit(c, { id: item.id, key, ownerId }, "restored", {
      state: "restored",
      policy: opts.auto ? "procedure_failed" : "manual",
      reason: opts.auto ? "procedure succeeded again" : `restored by ${by}`,
      was: aging.state,
      was_policy: aging.policy,
      pinned: !opts.auto,
      by: opts.auto ? "auto: procedure succeeded again" : by,
    });
    countMemoryAging(opts.auto ? "procedure_failed" : "manual", "restore");
    return { key, restored: true, enabled: !needsApproval, pinned: !opts.auto };
  });
}

/** A person lets automatic aging look at a restored item again. */
export async function unpinMemory(key: string, ownerId: number | null, by: string) {
  return withTx(async (c) => {
    const row = await one<{ id: number }>(
      c,
      `SELECT i.id FROM knowledge_items i JOIN knowledge_aging a ON a.item_id = i.id
        WHERE i.key = $1 AND i.owner_id IS NOT DISTINCT FROM $2 AND i.category = 'task_memory' AND a.pinned FOR UPDATE OF a`,
      [key, ownerId],
    );
    if (!row) throw new HttpError(409, "this memory item is not pinned");
    await q(c, "UPDATE knowledge_aging SET pinned = false WHERE item_id = $1", [row.id]);
    await audit(c, { id: row.id, key, ownerId }, "unpinned", { by });
    return { key, pinned: false };
  });
}

/** The 7b rule: a learned procedure that succeeded again comes back by itself, unpinned. */
export async function restoreProcedureIfArchived(ownerId: number, key: string) {
  const row = await one<{ state: string; policy: string | null; pinned: boolean }>(
    pool,
    `SELECT a.state, a.policy, a.pinned FROM knowledge_items i JOIN knowledge_aging a ON a.item_id = i.id
      WHERE i.key = $1 AND i.owner_id = $2`,
    [key, ownerId],
  );
  if (!row || row.state !== "archived" || row.policy !== "procedure_failed" || row.pinned)
    return false;
  await restoreMemory(key, ownerId, "memory aging", { auto: true });
  return true;
}

export interface AgingInfo {
  state: string;
  policy: string | null;
  reason: string | null;
  replaced_by_key: string | null;
  at: Date;
  pinned: boolean;
}
/** Aging state of several items (list views): only items that are not simply active are returned. */
export async function agingForItems(ids: number[], db: Db = pool) {
  const out = new Map<number, AgingInfo>();
  if (!ids.length) return out;
  const rows = await q<AgingInfo & { item_id: number }>(
    db,
    `SELECT item_id, state, policy, reason, replaced_by_key, at, pinned FROM knowledge_aging
      WHERE item_id = ANY($1) AND state <> 'active'`,
    [ids],
  );
  for (const r of rows) out.set(Number(r.item_id), r);
  return out;
}
export const isArchivedState = (state: string | undefined | null) =>
  state === "archived" || state === "superseded";

/** Aging state of one item, for the item page. */
export function agingOf(itemId: number, db: Db = pool) {
  return one<{
    state: string;
    policy: string | null;
    reason: string | null;
    replaced_by_key: string | null;
    at: Date;
    pinned: boolean;
  }>(
    db,
    "SELECT state, policy, reason, replaced_by_key, at, pinned FROM knowledge_aging WHERE item_id = $1 AND state <> 'active'",
    [itemId],
  );
}
