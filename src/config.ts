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
  /** Task project name -> repos the agent may touch. Unknown project = every git repo in reposRoot. */
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
  /** Organization name used for ORGANIZATION-scoped knowledge. */
  organization: string;
  /** Durable workflow scheduler. */
  scheduler: {
    /** Worker loops in this process (concurrent step executions). Defaults to maxConcurrent. */
    workers: number;
    leaseSeconds: number;
    heartbeatSeconds: number;
    pollMs: number;
  };
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
  organization: "hasaki",
  scheduler: { workers: 0, leaseSeconds: 60, heartbeatSeconds: 10, pollMs: 1000 },
  jira: { baseUrl: "", user: "", token: "" },
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
  };
  if (!cfg.scheduler.workers) cfg.scheduler.workers = cfg.maxConcurrent;
  cfg.jira.user = process.env.JIRA_USER ?? cfg.jira.user;
  cfg.jira.token = process.env.JIRA_TOKEN ?? cfg.jira.token;
  cfg.databaseUrl = process.env.DATABASE_URL ?? cfg.databaseUrl;
  // Secrets may come from env so config.json can be committed.
  cfg.bitbucket.user = process.env.BITBUCKET_USER ?? cfg.bitbucket.user;
  cfg.bitbucket.token = process.env.BITBUCKET_TOKEN ?? cfg.bitbucket.token;
  cfg.notifyWebhook = process.env.NOTIFY_WEBHOOK ?? cfg.notifyWebhook;
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (!cfg.publicUrl) cfg.publicUrl = `http://localhost:${cfg.port}`;
  mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}

export const config = load();
