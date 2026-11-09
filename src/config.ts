import { execution } from "./auth/execution.ts";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { persistentInstanceId } from "./instanceIdentity.ts";

export interface CodeIntelligenceConfig {
  enabled: boolean;
  includeGenerated: boolean;
  includeDependencies: boolean;
  maxFileBytes: number;
  maxFiles: number;
  maxScanBytes: number;
  maxSymbols: number;
  concurrency: number;
  timeoutMs: number;
  contextTokens: number;
  retentionDays: number;
  /** Repository-relative directory prefixes, additive to default exclusions. */
  excludes: string[];
  /** Both use the bundled SQL grammar; unsupported dialect syntax is skipped, never translated. */
  sqlDialect: "postgresql" | "generic";
  weights: {
    exact: number;
    qualified: number;
    path: number;
    dependency: number;
    text: number;
    cap: number;
  };
}

export interface Config {
  /** Optional local source indexing; paths and worker ownership follow existing instance configuration. */
  codeIntelligence: CodeIntelligenceConfig;
  evaluation: {
    enabled: boolean;
    maxCases: number;
    maxRepetitions: number;
    maxCaseSeconds: number;
    maxTokens: number;
    maxCostUsd: number;
    sandboxImage: string;
    maxLiveAgents: number;
  };
  port: number;
  /**
   * This platform instance (one per developer machine sharing the database). Runs created here are pinned to it and
   * only its workers execute them. PLATFORM_INSTANCE overrides; otherwise persisted under dataDir.
   */
  instanceId: string;
  instance: { heartbeatSeconds: number; offlineSeconds: number };
  /** LOCAL checkout overrides, never synchronized to PostgreSQL. */
  repositories: Record<string, string>;
  /** Where the real repo checkouts live (oms-api, oms-background, ...). */
  reposRoot: string;
  /** Platform data: worktrees, downloaded task files, Chromium profile. */
  dataDir: string;
  /** Branch new task branches are cut from. */
  baseBranch: string;
  /** Task project name -> repository paths or group folders under reposRoot. Synced into the repository registry. */
  projects: Record<string, string[]>;
  /**
   * Projects that integrate tightly (e.g. OMS calls Payment): a run for one may need to change the other. Each entry
   * links both ways and one hop only — `{ "OMS": ["Payment"] }` lets an OMS run see Payment repos AND a Payment run
   * see OMS repos; projects linked to Payment are not pulled into OMS. Names match config.projects (case-insensitive).
   */
  relatedProjects: Record<string, string[]>;
  /** Prefix to turn task note_files ("task/26/10/30/...png") into a downloadable URL. Empty = don't download. */
  fileBaseUrl: string;
  bitbucket: {
    /** Explicit process service account may be used when no personal credential exists. */
    allowSharedCredentials?: boolean;
    workspace: string;
    /** Atlassian account email (API token) or Bitbucket username (app password). Empty = no API, return a "create PR" link instead. */
    user: string;
    token: string;
    reviewers: string[]; // Bitbucket account UUIDs, e.g. "{xxxxxxxx-...}"
  };
  /** Optional: POST {text} here on question / PR / failure (Google Chat, Slack incoming webhook...). */
  notifyWebhook: string;
  /** Public URL of this platform, used in notifications. */
  publicUrl: string;
  /** Claude model override; empty = Claude Code default. */
  model: string;
  maxConcurrent: number;
  maxTurns: number;
  hasakiWork: {
    apiUrl: string;
    /** Poll the task list every N minutes and auto-pick new tasks. 0 = only when you click "Lấy task". */
    pollMinutes: number;
    /** wshr API paths (relative to apiUrl). Check ~/.claude-task-platform/work-api.log if Hasaki changes them. */
    listPath: string;
    detailPath: string;
    /** Query of the task list page, e.g. status=_00_01 (to_date is set to today). */
    listQuery: Record<string, string>;
    /** Auto-import new tasks from the list (true) or just list them for you to pick (false). Importing never executes. */
    autoPick: boolean;
    /** Workflow key auto-started for auto-picked tasks (the automation policy). Empty = import only. */
    autoWorkflow: string;
  };
  databaseUrl: string;
  /**
   * Local PostgreSQL pool. Default 10 clients is enough for one user and a few workflows.
   * Override in config.json (`database`) or with DATABASE_POOL_MAX / DATABASE_CONNECTION_TIMEOUT_MS /
   * DATABASE_POOL_MIN / DATABASE_IDLE_TIMEOUT_MS. The defaults favour a remote database (shared RDS over VPN): a new
   * TLS connection costs several round trips, so a handful of clients stay open instead of closing after 10 s idle.
   */
  database: {
    poolMax: number;
    poolMin: number;
    connectionTimeoutMillis: number;
    idleTimeoutMillis: number;
  };
  /** Organization name used for ORGANIZATION-scoped knowledge. */
  organization: string;
  /** Durable workflow scheduler. */
  scheduler: {
    /** Worker loops in this process (concurrent step executions). Defaults to maxConcurrent. */
    workers: number;
    /** Workers reserved for short steps (approval, discovery, condition, PR). Default 1. */
    lightWorkers: number;
    leaseSeconds: number;
    heartbeatSeconds: number;
    pollMs: number;
  };
  /** Agent context and capability shaping (single agent + skills + tools). */
  /** Continuous learning (knowledge/learning.ts): change detection from completed runs → reviewable proposals. */
  learning: {
    /** Detect knowledge changes when a run completes (one tool-less completion per run that has human input). */
    detectChanges: boolean;
    /** Existing rules shown to the analyzer (most relevant first). */
    maxRulesInPrompt: number;
    /** Characters of human input (answers, comments, requirement) analysed per run. */
    maxSourceChars: number;
    /** After a rule change is approved, draft updates for the skills it affects (each needs its own approval). */
    evolveSkills: boolean;
  };
  agent: {
    /** Bound retrieved context, using a documented character-based token estimate; provider usage remains separate. */
    contextTokens?: number;
    contextToolTimeoutMs?: number;
    /**
     * Claude Code settings layers loaded by agent steps. Default [] so skills come from ONE place, the platform
     * knowledge registry (imported from repos and ~/.claude/skills), instead of also being auto-loaded by Claude Code.
     */
    settingSources: Array<"user" | "project" | "local">;
    /** Token budget for knowledge inlined in the system prompt (explicit + mandatory items always included). */
    inlineKnowledgeTokens: number;
    /** How many on-demand skills/docs are listed in the prompt index; the rest are reachable via search_knowledge. */
    knowledgeIndexSize: number;
    /** Token budget for upstream step outputs in the user prompt; larger outputs are summarized. */
    upstreamTokens: number;
    /** Default agent provider. */
    defaultProvider?: "claude" | "codex" | "cursor" | "antigravity";
    cursorBin?: string;
    claudeBin?: string;
    /**
     * OpenAI Codex CLI (provider "codex"). Runs as the Codex login of the WORKER machine (`codex login`, e.g. a ChatGPT
     * account); the platform never reads auth.json and never switches to an API key on its own. Claude model ids are
     * never sent to it: Codex has its own model / effort / routing. Env overrides: CODEX_BIN, CODEX_TIMEOUT_MS,
     * CODEX_MODEL, CODEX_REASONING_EFFORT.
     */
    codex?: CodexConfig;
    /**
     * Google Antigravity CLI (provider "antigravity"). Runs as the authenticated account of the WORKER machine.
     * Env overrides: AGY_BIN / ANTIGRAVITY_BIN, AGY_TIMEOUT_MS / ANTIGRAVITY_TIMEOUT_MS,
     * AGY_MODEL / ANTIGRAVITY_MODEL, AGY_EFFORT / ANTIGRAVITY_EFFORT.
     */
    antigravity?: AntigravityConfig;
    /**
     * Optional model routing, e.g. { "FAST": { "agent": "<model>" }, "DEEP": { "verifier": "<model>" }, "*": { "coding_agent": "<model>" } }.
     * Keys: profile (or "*") → step type, or "verifier" for independent verification steps. Resolution order:
     * step config.model → models[profile][role] → models["*"][role] → config.model → SDK default. No model ids in code.
     */
    models?: Record<string, Record<string, string>>;
  };
  /** Optional one-way Telegram notifications (env TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID; never put the token in config.json). */
  telegram: {
    botToken: string;
    chatId: string;
    apiBase: string;
    mode: "off" | "polling" | "webhook";
    webhookSecret: string;
    webhookUrl: string;
  };
  /** Argo CD (QC) for reading pod logs during bug investigation. The token is pasted in the UI (Integrations), never in config. */
  argocd: { baseUrl: string };
  /**
   * Splunk (production SIEM). The session cookie is pasted in the UI (Integrations), never in config.
   * allowedIndexes: when non-empty, every search must name only these indexes. maxMinutes / maxResults cap each search.
   */
  /** Kafka UI (kafbat, QC). Session cookie pasted in the UI. cluster: empty = the only online cluster. */
  /** Vault (QC). Token pasted in the UI; values are never returned to agents. */
  vault: { baseUrl: string };
  kafka: {
    baseUrl: string;
    cluster: string;
    maxMessages: number;
    timeoutSeconds: number;
  };
  splunk: {
    baseUrl: string;
    locale: string;
    allowedIndexes: string[];
    maxMinutes: number;
    maxResults: number;
    timeoutSeconds: number;
  };
  /** Daily production error scan over Splunk (page "Lỗi production"). */
  prodErrors: {
    /** LOCAL explicit actor for the existing scheduled scan. Unset = manual scans only. */
    userId?: number;
    index: string;
    /** Kubernetes namespace → platform project (the project the "Điều tra" work item belongs to). */
    namespaces: Array<{ namespace: string; project: string }>;
    timezone: string;
    /** Default scan times (HH:MM, local); editable on the page. */
    schedule: string[];
    timeoutSeconds: number;
  };
  jira: {
    /** e.g. https://hasaki.atlassian.net. Empty = Jira import disabled. */
    baseUrl: string;
    user: string;
    token: string;
  };
}

const defaults: Config = {
  codeIntelligence: {
    enabled: false,
    includeGenerated: false,
    includeDependencies: false,
    maxFileBytes: 512 * 1024,
    maxFiles: 20000,
    maxScanBytes: 128 * 1024 * 1024,
    maxSymbols: 2000,
    concurrency: 1,
    timeoutMs: 120000,
    contextTokens: 2000,
    retentionDays: 7,
    excludes: [],
    sqlDialect: "postgresql",
    weights: {
      exact: 2,
      qualified: 2,
      path: 0.5,
      dependency: 0.5,
      text: 0.25,
      cap: 3,
    },
  },
  evaluation: {
    enabled: false,
    maxCases: 20,
    maxRepetitions: 3,
    maxCaseSeconds: 30,
    maxTokens: 20000,
    maxCostUsd: 2,
    sandboxImage: "docker.io/library/postgres:17-alpine",
    maxLiveAgents: 1,
  },
  port: 4545,
  reposRoot: join(homedir(), "src"),
  dataDir: join(homedir(), ".claude-task-platform"),
  instanceId: "",
  instance: { heartbeatSeconds: 15, offlineSeconds: 60 },
  repositories: {},
  baseBranch: "release/prod",
  projects: {
    OMS: [
      "oms-api",
      "oms-background",
      "oms-frontend",
      "oms-gateway",
      "oms-export",
      "oms-invoice",
      "oms-open-gateway",
    ],
  },
  relatedProjects: {},
  fileBaseUrl: "",
  bitbucket: { workspace: "hasaki-tech", user: "", token: "", reviewers: [] },
  notifyWebhook: "",
  publicUrl: "",
  model: "",
  maxConcurrent: 1,
  maxTurns: 300,
  hasakiWork: {
    apiUrl: "https://wshr.hasaki.vn/api",
    pollMinutes: 0,
    listPath: "hr/projects/mytasks-es",
    detailPath: "hr/projects/task-input/{id}",
    listQuery: {
      option: "my-task",
      status: "_00_01",
      limit: "100",
      offset: "0",
    },
    autoPick: false,
    autoWorkflow: "",
  },
  databaseUrl: "postgres://platform:platform@localhost:55432/platform",
  database: {
    poolMax: 10,
    poolMin: 4,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 300000,
  },
  organization: "hasaki",
  scheduler: {
    workers: 0,
    lightWorkers: 1,
    leaseSeconds: 120,
    heartbeatSeconds: 10,
    pollMs: 1000,
  },
  jira: { baseUrl: "", user: "", token: "" },
  argocd: { baseUrl: "https://argocd-qc-v2.hasaki.dev" },
  vault: { baseUrl: "https://vault-qc-v2.hasaki.dev" },
  kafka: {
    baseUrl: "https://kafka-ui-qc-v2.hasaki.dev",
    cluster: "",
    maxMessages: 200,
    timeoutSeconds: 60,
  },
  splunk: {
    baseUrl: "https://siem.hasaki.work",
    locale: "en-US",
    allowedIndexes: [],
    maxMinutes: 7 * 24 * 60,
    maxResults: 500,
    timeoutSeconds: 60,
  },
  telegram: {
    botToken: "",
    chatId: "",
    apiBase: "https://api.telegram.org",
    mode: "off",
    webhookSecret: "",
    webhookUrl: "",
  },
  prodErrors: {
    index: "k8s_prod",
    namespaces: [
      { namespace: "oms-prod", project: "OMS" },
      { namespace: "payment-prod", project: "Payment" },
    ],
    timezone: "Asia/Ho_Chi_Minh",
    schedule: ["09:00", "14:00", "17:00"],
    timeoutSeconds: 300,
  },
  learning: {
    detectChanges: true,
    maxRulesInPrompt: 20,
    maxSourceChars: 6000,
    evolveSkills: true,
  },
  agent: {
    contextTokens: 24000,
    contextToolTimeoutMs: 10000,
    settingSources: [],
    inlineKnowledgeTokens: 8000,
    knowledgeIndexSize: 12,
    upstreamTokens: 12000,
  },
};

export let instanceIdentityExplicit = false;

function load(): Config {
  const file = resolve(process.env.PLATFORM_CONFIG ?? "config.json");
  const fromFile = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : {};
  const cfg: Config = {
    ...defaults,
    ...fromFile,
    evaluation: { ...defaults.evaluation, ...(fromFile.evaluation ?? {}) },
    codeIntelligence: {
      ...defaults.codeIntelligence,
      ...(fromFile.codeIntelligence ?? {}),
      weights: {
        ...defaults.codeIntelligence.weights,
        ...(fromFile.codeIntelligence?.weights ?? {}),
      },
    },
    bitbucket: { ...defaults.bitbucket, ...(fromFile.bitbucket ?? {}) },
    hasakiWork: { ...defaults.hasakiWork, ...(fromFile.hasakiWork ?? {}) },
    scheduler: { ...defaults.scheduler, ...(fromFile.scheduler ?? {}) },
    instance: { ...defaults.instance, ...(fromFile.instance ?? {}) },
    jira: { ...defaults.jira, ...(fromFile.jira ?? {}) },
    argocd: { ...defaults.argocd, ...(fromFile.argocd ?? {}) },
    splunk: { ...defaults.splunk, ...(fromFile.splunk ?? {}) },
    kafka: { ...defaults.kafka, ...(fromFile.kafka ?? {}) },
    vault: { ...defaults.vault, ...(fromFile.vault ?? {}) },
    prodErrors: { ...defaults.prodErrors, ...(fromFile.prodErrors ?? {}) },
    agent: { ...defaults.agent, ...(fromFile.agent ?? {}) },
    learning: { ...defaults.learning, ...(fromFile.learning ?? {}) },
    database: { ...defaults.database, ...(fromFile.database ?? {}) },
  };
  for (const k of [
    "maxCases",
    "maxRepetitions",
    "maxCaseSeconds",
    "maxTokens",
    "maxLiveAgents",
  ] as const)
    cfg.evaluation[k] = positiveInt(`evaluation.${k}`, cfg.evaluation[k]);
  if (
    !Number.isFinite(cfg.evaluation.maxCostUsd) ||
    cfg.evaluation.maxCostUsd < 0
  )
    throw new Error("evaluation.maxCostUsd must be nonnegative");
  for (const k of [
    "maxFileBytes",
    "maxFiles",
    "maxScanBytes",
    "maxSymbols",
    "concurrency",
    "timeoutMs",
    "contextTokens",
    "retentionDays",
  ] as const)
    cfg.codeIntelligence[k] = positiveInt(
      `codeIntelligence.${k}`,
      cfg.codeIntelligence[k],
    );
  for (const v of Object.values(cfg.codeIntelligence.weights))
    if (!Number.isFinite(v) || v < 0)
      throw new Error("Invalid code intelligence weight");
  if (!["postgresql", "generic"].includes(cfg.codeIntelligence.sqlDialect))
    throw new Error("Unsupported SQL dialect");
  if (!cfg.scheduler.workers) cfg.scheduler.workers = cfg.maxConcurrent;
  cfg.telegram = {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: process.env.TELEGRAM_CHAT_ID ?? "",
    apiBase: process.env.TELEGRAM_API_BASE ?? defaults.telegram.apiBase,
    mode: (process.env.TELEGRAM_MODE ?? "off") as "off" | "polling" | "webhook",
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? "",
    webhookUrl: process.env.TELEGRAM_WEBHOOK_URL ?? "",
  };
  if (!["off", "polling", "webhook"].includes(cfg.telegram.mode))
    throw new Error("Invalid TELEGRAM_MODE");
  if (
    cfg.telegram.mode === "webhook" &&
    (!/^https:\/\//.test(cfg.telegram.webhookUrl) ||
      !/^[A-Za-z0-9_-]{16,256}$/.test(cfg.telegram.webhookSecret))
  )
    throw new Error(
      "Telegram webhook needs HTTPS TELEGRAM_WEBHOOK_URL and a 16-256 character TELEGRAM_WEBHOOK_SECRET",
    );
  cfg.jira.user = process.env.JIRA_USER ?? cfg.jira.user;
  cfg.jira.token = process.env.JIRA_TOKEN ?? cfg.jira.token;
  cfg.dataDir = resolve(cfg.dataDir);
  cfg.reposRoot = resolve(cfg.reposRoot);
  instanceIdentityExplicit = !!(
    process.env.PLATFORM_INSTANCE?.trim() || cfg.instanceId
  );
  cfg.instanceId = persistentInstanceId(
    cfg.dataDir,
    process.env.PLATFORM_INSTANCE?.trim() || cfg.instanceId,
  );
  cfg.instance.heartbeatSeconds = positiveInt(
    "instance.heartbeatSeconds",
    cfg.instance.heartbeatSeconds,
  );
  cfg.instance.offlineSeconds = positiveInt(
    "instance.offlineSeconds",
    cfg.instance.offlineSeconds,
  );
  if (cfg.instance.offlineSeconds <= cfg.instance.heartbeatSeconds * 2)
    throw new Error(
      "instance.offlineSeconds must exceed twice heartbeatSeconds",
    );
  for (const key of [
    "workers",
    "leaseSeconds",
    "heartbeatSeconds",
    "pollMs",
  ] as const)
    cfg.scheduler[key] = positiveInt(`scheduler.${key}`, cfg.scheduler[key]);
  if (cfg.scheduler.heartbeatSeconds >= cfg.scheduler.leaseSeconds)
    throw new Error("scheduler heartbeat must be shorter than lease");
  if (
    !Number.isInteger(cfg.scheduler.lightWorkers) ||
    cfg.scheduler.lightWorkers < 0
  )
    throw new Error("scheduler.lightWorkers must be nonnegative");
  const dbUrl = new URL(process.env.DATABASE_URL ?? cfg.databaseUrl);
  if (!["postgres:", "postgresql:"].includes(dbUrl.protocol))
    throw new Error("databaseUrl must use PostgreSQL");
  cfg.databaseUrl = process.env.DATABASE_URL ?? cfg.databaseUrl;
  cfg.database = {
    poolMax: positiveInt(
      "database.poolMax",
      process.env.DATABASE_POOL_MAX ?? cfg.database.poolMax,
    ),
    poolMin: Math.max(
      0,
      Number(process.env.DATABASE_POOL_MIN ?? cfg.database.poolMin) || 0,
    ),
    connectionTimeoutMillis: positiveInt(
      "database.connectionTimeoutMillis",
      process.env.DATABASE_CONNECTION_TIMEOUT_MS ??
      cfg.database.connectionTimeoutMillis,
    ),
    idleTimeoutMillis: positiveInt(
      "database.idleTimeoutMillis",
      process.env.DATABASE_IDLE_TIMEOUT_MS ?? cfg.database.idleTimeoutMillis,
    ),
  };
  cfg.database.poolMin = Math.min(cfg.database.poolMin, cfg.database.poolMax);
  // Secrets may come from env so config.json can be committed.
  cfg.bitbucket.user = process.env.BITBUCKET_USER ?? cfg.bitbucket.user;
  cfg.bitbucket.token = process.env.BITBUCKET_TOKEN ?? cfg.bitbucket.token;
  cfg.notifyWebhook = process.env.NOTIFY_WEBHOOK ?? cfg.notifyWebhook;
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (!cfg.publicUrl) cfg.publicUrl = `http://localhost:${cfg.port}`;
  mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}

/** Positive integer from config.json or the environment. NaN, fractions, and values below 1 are rejected. */
export function positiveInt(name: string, raw: unknown): number {
  if (typeof raw !== "number" && typeof raw !== "string")
    throw new Error(`${name} must be a positive integer`);
  const n = typeof raw === "number" ? raw : Number(raw.trim());
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`${name} must be a positive integer`);
  return n;
}

export interface CodexConfig {
  /** Executable. Empty uses `codex` on PATH. */
  bin?: string;
  /** Hard limit for one Codex turn (process). Default 45 minutes. */
  timeoutMs?: number;
  /** Codex model slug (see `codex debug models`). Empty = the Codex account default. */
  model?: string;
  /** model_reasoning_effort, e.g. low | medium | high | xhigh. Empty = the model default. */
  reasoningEffort?: string;
  /** Same shape as agent.models (profile or "*" → step type or "verifier"), with Codex model slugs only. */
  models?: Record<string, Record<string, string>>;
}

/** Codex settings with env overrides applied. Read at call time so tests and operators can change env. */
export function codexConfig(): Required<
  Pick<CodexConfig, "bin" | "timeoutMs" | "model" | "reasoningEffort">
> & { models: Record<string, Record<string, string>> } {
  if (execution.getStore()?.evaluation?.fixtureAgent)
    return {
      bin: join(
        import.meta.dirname,
        "..",
        "test",
        "fixtures",
        "fake-codex.mjs",
      ),
      timeoutMs: 15000,
      model: "gpt-test",
      reasoningEffort: "low",
      models: {},
    };
  const c = config.agent.codex ?? {};
  const timeout = Number(
    process.env.CODEX_TIMEOUT_MS || c.timeoutMs || 45 * 60 * 1000,
  );
  return {
    bin: process.env.CODEX_BIN || c.bin || "codex",
    timeoutMs:
      Number.isFinite(timeout) && timeout > 0 ? timeout : 45 * 60 * 1000,
    model: process.env.CODEX_MODEL ?? c.model ?? "",
    reasoningEffort:
      process.env.CODEX_REASONING_EFFORT ?? c.reasoningEffort ?? "",
    models: c.models ?? {},
  };
}

export interface AntigravityConfig {
  /** Executable. Empty uses `agy` on PATH. */
  bin?: string;
  /** Hard limit for one Antigravity turn (process). Default 45 minutes. */
  timeoutMs?: number;
  /** Antigravity model slug (e.g. gemini-3.8-flash-high). Empty = the agy default. */
  model?: string;
  /** Reasoning effort, e.g. low | medium | high | xhigh | max. Empty = model default. */
  effort?: string;
  /** Max concurrent Antigravity turns on this worker (default 1). */
  maxConcurrent?: number;
  /** Allow subagents (default false). */
  allowSubagents?: boolean;
  /** Run in a sandbox with terminal restrictions enabled (default true). */
  sandbox?: boolean;
  /** Same shape as agent.models (profile or "*" → step type or "verifier"), with Antigravity model slugs only. */
  models?: Record<string, Record<string, string>>;
}

/** Antigravity settings with env overrides applied. */
export function antigravityConfig(): Required<
  Pick<
    AntigravityConfig,
    | "bin"
    | "timeoutMs"
    | "model"
    | "effort"
    | "maxConcurrent"
    | "allowSubagents"
    | "sandbox"
  >
> & { models: Record<string, Record<string, string>> } {
  if (execution.getStore()?.evaluation?.fixtureAgent)
    return {
      bin: join(import.meta.dirname, "..", "test", "fixtures", "fake-agy.mjs"),
      timeoutMs: 15000,
      model: "gemini-test",
      effort: "medium",
      maxConcurrent: 1,
      allowSubagents: false,
      sandbox: true,
      models: {},
    };
  const c = config.agent.antigravity ?? {};
  const timeout = Number(
    process.env.AGY_TIMEOUT_MS ||
    process.env.ANTIGRAVITY_TIMEOUT_MS ||
    c.timeoutMs ||
    45 * 60 * 1000,
  );
  const maxConcurrent = Number(
    process.env.AGY_MAX_CONCURRENT ||
    process.env.ANTIGRAVITY_MAX_CONCURRENT ||
    c.maxConcurrent ||
    1,
  );
  return {
    bin: process.env.AGY_BIN || process.env.ANTIGRAVITY_BIN || c.bin || "agy",
    timeoutMs:
      Number.isFinite(timeout) && timeout > 0 ? timeout : 45 * 60 * 1000,
    model:
      process.env.AGY_MODEL ?? process.env.ANTIGRAVITY_MODEL ?? c.model ?? "",
    effort:
      process.env.AGY_EFFORT ??
      process.env.ANTIGRAVITY_EFFORT ??
      c.effort ??
      "",
    maxConcurrent:
      Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 1,
    allowSubagents:
      (process.env.AGY_ALLOW_SUBAGENTS ??
        process.env.ANTIGRAVITY_ALLOW_SUBAGENTS)
        ? process.env.AGY_ALLOW_SUBAGENTS === "true" ||
        process.env.ANTIGRAVITY_ALLOW_SUBAGENTS === "true"
        : (c.allowSubagents ?? false),
    sandbox:
      (process.env.AGY_SANDBOX ?? process.env.ANTIGRAVITY_SANDBOX)
        ? process.env.AGY_SANDBOX === "true" ||
        process.env.ANTIGRAVITY_SANDBOX === "true"
        : (c.sandbox ?? true),
    models: c.models ?? {},
  };
}

export const config = load();

/** Evaluation overrides are per async execution, never shared mutable flags. */
export function codeIntelligenceEnabled() {
  return (
    execution.getStore()?.evaluation?.codeIntelligence ??
    config.codeIntelligence.enabled
  );
}
