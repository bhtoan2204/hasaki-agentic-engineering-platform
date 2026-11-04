import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Config {
  port: number;
  /** Where the real repo checkouts live (oms-api, oms-background, ...). */
  reposRoot: string;
  /** Platform data: worktrees, downloaded task files, Chromium profile. */
  dataDir: string;
  /** Branch new task branches are cut from. */
  baseBranch: string;
  /** Task project name -> repository paths or group folders under reposRoot. Synced into the repository registry. */
  projects: Record<string, string[]>;
  /** Prefix to turn task note_files ("task/26/10/30/...png") into a downloadable URL. Empty = don't download. */
  fileBaseUrl: string;
  bitbucket: {
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
    /** Empty = the Chromium that playwright-core ships with (~/.cache/ms-playwright). */
    chromiumPath: string;
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
   * Override in config.json (`database`) or with DATABASE_POOL_MAX / DATABASE_CONNECTION_TIMEOUT_MS.
   */
  database: { poolMax: number; connectionTimeoutMillis: number };
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
  agent: {
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
    /**
     * Optional model routing, e.g. { "FAST": { "agent": "<model>" }, "DEEP": { "verifier": "<model>" }, "*": { "coding_agent": "<model>" } }.
     * Keys: profile (or "*") → step type, or "verifier" for independent verification steps. Resolution order:
     * step config.model → models[profile][role] → models["*"][role] → config.model → SDK default. No model ids in code.
     */
    models?: Record<string, Record<string, string>>;
  };
  /** Optional one-way Telegram notifications (env TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID; never put the token in config.json). */
  telegram: { botToken: string; chatId: string; apiBase: string };
  jira: {
    /** e.g. https://hasaki.atlassian.net. Empty = Jira import disabled. */
    baseUrl: string;
    user: string;
    token: string;
  };
}

const defaults: Config = {
  port: 4545,
  reposRoot: join(homedir(), "src"),
  dataDir: join(homedir(), ".claude-task-platform"),
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
  fileBaseUrl: "",
  bitbucket: { workspace: "hasaki-tech", user: "", token: "", reviewers: [] },
  notifyWebhook: "",
  publicUrl: "",
  model: "",
  maxConcurrent: 1,
  maxTurns: 300,
  hasakiWork: {
    apiUrl: "https://wshr.hasaki.vn/api",
    chromiumPath: "",
    pollMinutes: 0,
    listPath: "hr/projects/mytasks-es",
    detailPath: "hr/projects/task-input/{id}",
    listQuery: { option: "my-task", status: "_00_01", limit: "100", offset: "0" },
    autoPick: false,
    autoWorkflow: "",
  },
  databaseUrl: "postgres://platform:platform@localhost:55432/platform",
  database: { poolMax: 10, connectionTimeoutMillis: 5000 },
  organization: "hasaki",
  scheduler: { workers: 0, lightWorkers: 1, leaseSeconds: 60, heartbeatSeconds: 10, pollMs: 1000 },
  jira: { baseUrl: "", user: "", token: "" },
  telegram: { botToken: "", chatId: "", apiBase: "https://api.telegram.org" },
  agent: { settingSources: [], inlineKnowledgeTokens: 8000, knowledgeIndexSize: 12, upstreamTokens: 12000 },
};

function load(): Config {
  const file = resolve(process.env.PLATFORM_CONFIG ?? "config.json");
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const cfg: Config = {
    ...defaults,
    ...fromFile,
    bitbucket: { ...defaults.bitbucket, ...(fromFile.bitbucket ?? {}) },
    hasakiWork: { ...defaults.hasakiWork, ...(fromFile.hasakiWork ?? {}) },
    scheduler: { ...defaults.scheduler, ...(fromFile.scheduler ?? {}) },
    jira: { ...defaults.jira, ...(fromFile.jira ?? {}) },
    agent: { ...defaults.agent, ...(fromFile.agent ?? {}) },
    database: { ...defaults.database, ...(fromFile.database ?? {}) },
  };
  if (!cfg.scheduler.workers) cfg.scheduler.workers = cfg.maxConcurrent;
  cfg.telegram = {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: process.env.TELEGRAM_CHAT_ID ?? "",
    apiBase: process.env.TELEGRAM_API_BASE ?? defaults.telegram.apiBase,
  };
  cfg.jira.user = process.env.JIRA_USER ?? cfg.jira.user;
  cfg.jira.token = process.env.JIRA_TOKEN ?? cfg.jira.token;
  cfg.databaseUrl = process.env.DATABASE_URL ?? cfg.databaseUrl;
  cfg.database = {
    poolMax: positiveInt("database.poolMax", process.env.DATABASE_POOL_MAX ?? cfg.database.poolMax),
    connectionTimeoutMillis: positiveInt("database.connectionTimeoutMillis", process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? cfg.database.connectionTimeoutMillis),
  };
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
  if (typeof raw !== "number" && typeof raw !== "string") throw new Error(`${name} must be a positive integer`);
  const n = typeof raw === "number" ? raw : Number(raw.trim());
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

export const config = load();
