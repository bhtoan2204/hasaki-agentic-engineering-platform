import { availableParallelism, totalmem } from "node:os";
import { execution } from "./auth/execution.ts";
import { isOwned } from "./platform/operatorState.ts";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
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

export interface SupervisionLimits {
  memoryMb: number;
  pids: number;
  cpuPercent: number;
  cpuSeconds: number;
  fileSizeMb: number;
  openFiles: number;
}

export interface AnalyticsConfig {
  /** Deadline of one dashboard read in platform-go (queueing for an analytics slot included). */
  timeoutMs: number;
}

export type SlopSeverity = "low" | "medium" | "high";
/** Slop detection policy (src/slop). Stored settings override these per global/repository layer. */
export interface SlopSettings {
  /** disabled: no scan; advisory: report only; enforcement: new/worsened findings at blockSeverity fail verification. */
  mode: "disabled" | "advisory" | "enforcement";
  /** micro: deterministic rules only; auto: micro for MICRO runs and small FAST diffs, otherwise standard. */
  level: "auto" | "micro" | "standard";
  languages: Record<string, boolean>;
  /** Rule id → false disables the rule. */
  rules: Record<string, boolean>;
  thresholds: {
    cyclomatic: number;
    cyclomaticHigh: number;
    cognitive: number;
    duplicateLines: number;
  };
  /** Findings below this severity are not reported. */
  minSeverity: SlopSeverity;
  /** Enforcement blocks only findings at or above this confidence (0..1). */
  minConfidence: number;
  blockSeverity: SlopSeverity;
  /** Repository-relative path prefixes never scanned (in addition to generated/vendor exclusions). */
  excludePaths: string[];
  suppressions: Array<{ fingerprint: string; reason: string }>;
  maxFiles: number;
  timeoutMs: number;
}

export interface GitlabInstance {
  /** Lower-case host name, e.g. "gitlab.com" or "gitlab.hasaki.work". No scheme, path or port. */
  host: string;
  /** PEM bundle for an internal CA, used for Git transport to this host (http.<url>.sslCAInfo). TLS is never disabled. */
  caFile?: string;
  /**
   * Pinned SSH host keys ("ssh-ed25519 AAAA…") for Git over SSH. SSH transport is used only when this is set and the
   * user saved an SSH key for the host; StrictHostKeyChecking stays on, unknown keys are never accepted.
   */
  sshHostKeys?: string[];
  /** SSH port when the instance does not listen on 22. */
  sshPort?: number;
}

/** One OpenSSH public host key: "<type> <base64>" (comments dropped). */
export const SSH_HOST_KEY =
  /^(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa|sk-ssh-ed25519@openssh\.com) ([A-Za-z0-9+/]+={0,3})(?:\s.*)?$/;

export interface Config {
  knowledge: {
    ponytail: { enabled: boolean; mapChars: number };
  };
  /** Semantic re-ranking by the Go retrieval service (ADR 0001); the token comes only from RETRIEVAL_INTERNAL_TOKEN. */
  retrieval: {
    semantic: {
      enabled: boolean;
      url: string;
      timeoutMs: number;
      topK: number;
      minSimilarity: number;
    };
  };
  /** Optional local source indexing; paths and worker ownership follow existing instance configuration. */
  codeIntelligence: CodeIntelligenceConfig;
  slop: SlopSettings;
  evaluation: {
    enabled: boolean;
    maxCases: number;
    maxRepetitions: number;
    maxCaseSeconds: number;
    maxTokens: number;
    maxCostUsd: number;
    maxSuiteCostUsd: number;
    liveEnabled: boolean;
    liveUsageProviders: string[];
    estimatedUsdPerMillion: number;
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
  /**
   * Engineering analytics dashboards (src/api/analytics). "go" reads them through platform-go
   * (go/internal/analytics, ADR 0003); "typescript" is the in-process implementation and the fallback.
   */
  analytics: AnalyticsConfig;
  /** LOCAL checkout overrides, never synchronized to PostgreSQL. */
  repositories: Record<string, string>;
  /** LOCAL: shared registry entries this machine never checks out (no startup checkout warning). */
  ignoredRepositories?: string[];
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
    /**
     * How a user's own Bitbucket permission limits their repository access (src/repos/access.ts):
     *  - "strict" (default): read must be verified with the user's personal credentials; write and pull requests
     *    must be verified too. Unknown (no personal token, API unavailable) is never allowed.
     *  - "personal": read must be verified; write/PR that Bitbucket does not report (its permission API is
     *    workspace-admin only) are allowed because pushes and PRs then run with that same personal token, so
     *    Bitbucket itself enforces them. A shared service account never qualifies.
     *  - "trusted": an admin vouches that platform grants mirror Bitbucket for this team (e.g. everyone works through
     *    the shared service account). Bitbucket is not consulted; effective access = platform grant ∩ repository.
     */
    accessVerification?: "strict" | "personal" | "trusted";
    /** How long a Bitbucket permission check is reused before it is checked again (seconds, default 900). */
    permissionTtlSeconds?: number;
    workspace: string;
    /** Atlassian account email (API token) or Bitbucket username (app password). Empty = no API, return a "create PR" link instead. */
    user: string;
    token: string;
    reviewers: string[]; // Bitbucket account UUIDs, e.g. "{xxxxxxxx-...}"
  };
  /**
   * GitHub operations for repositories registered with a github.com URL. Personal tokens live in user secrets.
   * The process token is used for clone/push/PR only when allowSharedCredentials is true, and never as a permission grant.
   */
  github: {
    allowSharedCredentials?: boolean;
    /** Same meanings as bitbucket.accessVerification, checked with the user's GitHub token. */
    accessVerification?: "strict" | "personal" | "trusted";
    token: string;
  };
  /**
   * GitLab.com and self-hosted GitLab. Only hosts listed in `instances` are accepted as repository URLs, so a token is
   * never sent to an unregistered host. Personal tokens live in user secrets (`gitlab_token:<host>`); the process token
   * is never read from the environment (Integrations only), and never a permission grant.
   */
  gitlab: {
    instances: GitlabInstance[];
    allowSharedCredentials?: boolean;
    /** Same meanings as bitbucket.accessVerification, checked with the user's GitLab token. */
    accessVerification?: "strict" | "personal" | "trusted";
    token: string;
    requestTimeoutMs?: number;
    maxRetries?: number;
  };
  /**
   * This installation's own source repository. Empty repositoryUrl is detected from the live checkout's origin.
   * trustedOperatorIsolation allows Claude/Cursor coding and unsandboxed test commands on a single-operator machine.
   */
  platform: {
    repositoryUrl: string;
    trustedOperatorIsolation: boolean;
    /** Local PostgreSQL URL used only to CREATE DATABASE for self-development tests. Empty derives database `postgres`. */
    testDatabaseAdminUrl: string;
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
   * Default cost budgets in USD (provider-reported cost). null = no budget. A run's own budget, then its work item's,
   * override these. Checked after every attempt: `warnPct` logs a warning, 100% pauses the run when action = "pause".
   * Env: COST_BUDGET_RUN_USD / COST_BUDGET_WORK_ITEM_USD / COST_BUDGET_WARN_PCT / COST_BUDGET_ACTION.
   */
  costBudget: {
    runUsd: number | null;
    workItemUsd: number | null;
    warnPct: number;
    action: "pause" | "warn";
    unknownEstimate: "warn" | "pause";
  };
  /**
   * Routing guard rails. `sensitiveProviders`: providers with an approved security policy for HIGH_RISK work
   * (ROUTING_SENSITIVE_PROVIDERS, comma-separated; default: the platform's default provider only).
   */
  routing: { sensitiveProviders: string[] };
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
    /** Outcome lessons loaded into one step's context at most (best corroborated, same task class, fresh). */
    maxLessons: number;
  };
  agent: {
    /** Models no path may use (case-insensitive substrings of the model id). Default: ["fable"]. */
    blockedModels?: string[];
    /** Model context window (tokens) for compaction pressure; per-provider overrides. Default 200000. */
    contextWindowTokens?: number;
    contextWindows?: Record<string, number>;
    /**
     * Adaptive session compaction at safe boundaries (resume, repair rounds): above `pressure` (share of the context
     * window, provider-reported occupancy) a session is reconstructed from durable state ("reconstruct", default),
     * compacted by the provider when it supports it ("native"), or left alone ("off"). Default 0.6.
     */
    compaction?: { mode?: "reconstruct" | "native" | "off"; pressure?: number };
    /**
     * Send only what is new: delta context to resumed sessions, kept chat completion sessions, compacted earlier tool
     * results and intent-focused catalogs. false restores full resends (baseline for A/B benchmarks). Default true.
     */
    deltaContext?: boolean;
    /** Bound retrieved context, using a documented character-based token estimate; provider usage remains separate. */
    contextTokens?: number;
    contextToolTimeoutMs?: number;
    /**
     * After the agent submitted its result and its turn ended, how long the platform waits for the CLI to exit before
     * stopping the session. Background shell tasks keep the CLI alive (it re-invokes the agent when they finish), which
     * otherwise holds the step RUNNING and a worker slot for as long as that task runs.
     */
    postSubmitGraceSeconds?: number;
    /** Wall-clock limit of one agent turn when neither the step nor the provider config sets one. */
    turnTimeoutMs?: number;
    /**
     * A turn with no provider stream event, hook call or platform tool request for this long is stopped (IDLE_TIMEOUT).
     * A running shell command is silent, so this stays above the longest tool timeout (platform MCP tools: 30 min).
     */
    idleTimeoutMs?: number;
    /** Tool calls one attempt may make across all its turns, repairs included (TOOL_BUDGET_EXHAUSTED). */
    maxToolCalls?: number;
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
    defaultProvider?: "claude" | "codex" | "cursor" | "antigravity" | "copilot";
    /** Settings page. A false entry is off; omitted entries stay on. */
    enabledProviders?: Partial<
      Record<"claude" | "cursor" | "codex" | "antigravity" | "copilot", boolean>
    >;
    cursorBin?: string;
    claudeBin?: string;
    /**
     * OpenAI Codex CLI (provider "codex"). Runs as the Codex login of the WORKER machine (`codex login`, e.g. a ChatGPT
     * account); the platform never reads auth.json and never switches to an API key on its own. Claude model ids are
     * never sent to it: Codex has its own model / effort / routing. The Settings page wins for model and effort
     * once saved; otherwise CODEX_MODEL / CODEX_REASONING_EFFORT, then config.json. CODEX_BIN and
     * CODEX_TIMEOUT_MS stay process-local.
     */
    codex?: CodexConfig;
    /**
     * Google Antigravity CLI (provider "antigravity"). Runs as the authenticated account of the WORKER machine.
     * The Settings page wins for model, effort, sandbox and concurrency once saved; otherwise the
     * AGY_* / ANTIGRAVITY_* environment, then config.json. The binary path and turn timeout stay
     * process-local.
     */
    antigravity?: AntigravityConfig;
    /**
     * GitHub Copilot CLI (provider "copilot"). Runs as the authenticated account of the WORKER machine.
     * The Settings page wins for model, effort, sandbox and concurrency once saved; otherwise
     * COPILOT_MODEL / COPILOT_EFFORT / COPILOT_SANDBOX / COPILOT_MAX_CONCURRENT, then config.json.
     * The binary path and turn timeout stay process-local.
     */
    copilot?: CopilotConfig;
    /**
     * Optional model routing, e.g. { "FAST": { "agent": "<model>" }, "DEEP": { "verifier": "<model>" }, "*": { "coding_agent": "<model>" } }.
     * Keys: profile (or "*") → step type, or "verifier" for independent verification steps. Resolution order:
     * step config.model → models[profile][role] → models["*"][role] → config.model → SDK default. No model ids in code.
     */
    models?: Record<string, Record<string, string>>;
  };
  /** Telegram bot (Integrations page: encrypted shared token, mode off|polling); never read from the environment. */
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
  /**
   * QC business HTTP from chat (src/integrations/qcHttp.ts). `hosts`: exact hosts or "*.suffix" the platform may call;
   * empty = disabled. A production-looking host is always refused. `internalHosts`: hosts allowed to resolve to private
   * addresses. `preauthorized`: mutating requests that run without a per-call confirmation (method, host pattern, path
   * prefix). `auth`: backend-managed login profiles; credentials come from Vault and never reach the model.
   */
  qcHttp: {
    hosts: string[];
    internalHosts: string[];
    productionDomains: string[];
    preauthorized: Array<{ method: string; host: string; path: string }>;
    maxOperationsPerTurn: number;
    timeoutMs: number;
    maxBytes: number;
    auth: Record<
      string,
      {
        hosts: string[];
        login: {
          url: string;
          /** JSON body; "{{username}}" and "{{password}}" are filled in server-side. */
          body: Record<string, unknown>;
          /** Dotted path of the access token in the login response, e.g. "data.access_token". */
          tokenPath: string;
          /** Dotted path of the lifetime in seconds (default 15 minutes). */
          expiresInPath?: string;
        };
        header?: string;
        scheme?: string;
        credentials: { vault: { path: string; usernameKey: string; passwordKey: string } };
      }
    >;
  };
  kafka: {
    baseUrl: string;
    cluster: string;
    maxMessages: number;
    timeoutSeconds: number;
    /**
     * Producing (chat operations only, after the owner confirms). Empty = disabled. Each entry allows topics of one QC
     * cluster; a topic ending in `*` is a prefix. A production-looking base URL, cluster or topic is always refused.
     */
    publishAllow: Array<{ cluster: string; topics: string[]; preauthorized?: boolean }>;
  };
  splunk: {
    baseUrl: string;
    /**
     * Optional splunkd management endpoint (e.g. https://splunk.example:8089) for token authentication. Empty = token
     * searches go through Splunk Web's proxy (`<baseUrl>/<locale>/splunkd/__raw`), which accepts `Authorization: Bearer`.
     */
    managementUrl: string;
    locale: string;
    allowedIndexes: string[];
    maxMinutes: number;
    maxResults: number;
    timeoutSeconds: number;
    /** Label shown to users and recorded with every search; investigations default to it. */
    environment: string;
    /** Timezone used to read and display investigation times (Splunk `_time` keeps its own offset). */
    timezone: string;
    /** Indexes an investigation searches when the request names none (must be within allowedIndexes when that is set). */
    defaultIndexes: string[];
    /** Concurrent Splunk searches per platform process. */
    concurrency: number;
    /** Searches one investigation run may execute against Splunk (cache hits and manual results do not count). */
    queryBudget: number;
    /** Let members use the administrator-managed shared service token when they have no personal session. */
    allowSharedToken: boolean;
  };
  /** SigNoz (logs, traces, metrics) read through the v5 query_range API with each user's own API key. */
  /**
   * Iterative production investigation: rounds of evidence seeking after the first findings (each round re-runs the
   * refine search, timeline and findings steps). 0 = off: every round's state is still evaluated and recorded (shadow).
   */
  investigation: { maxRounds: number };
  /**
   * Pull request delivery lifecycle after publication. "off" (default) = nothing is polled; "monitor" = read-only status
   * (CI, reviews, mergeability bound to the verified SHA) with ready/blocker notifications; "repair" = also re-executes
   * the run's coding step for an eligible code CI failure or a trusted in-scope review, only when the autonomy policy
   * and the enforced OS sandbox allow unattended work (otherwise a shadow repair plan is recorded). Never merges.
   */
  prLifecycle: {
    mode: "off" | "monitor" | "repair";
    pollSeconds: number;
    maxRepairs: number;
    /** Reviewers whose in-scope comments may drive a repair (everyone else's comments only block). */
    trustedReviewers: string[];
    /** Usernames whose comments are the platform's own echo (ignored). */
    botUsernames: string[];
    /** Explicit required checks per repository; absent = a successful pipeline for the head is required; [] = CI not required. */
    requiredChecks: Record<string, string[]>;
  };
  /**
   * LSP semantic navigation (P1-B, ADR 0009): definition/references/symbols/diagnostics/incoming calls from gopls and
   * the TypeScript language service, over an authorized checkout or run worktree. Off by default (LSP_ENABLED=1).
   * Servers run in the OS sandbox; without one only when allowUnsandboxed (operator opt-in). gopls: binary override.
   */
  lsp: {
    enabled: boolean;
    allowUnsandboxed: boolean;
    gopls: string;
    maxSessions: number;
    idleMs: number;
    requestTimeoutMs: number;
    startupTimeoutMs: number;
    maxResults: number;
  };
  /**
   * CodeAct (P1-A, ADR 0008): read-only programmatic tool calling. A short JavaScript program runs in the OS sandbox
   * (no network, no credentials) and reaches read-only registry tools only through the parent broker. Off by default;
   * unavailable whenever the isolation runtime is (never runs in the worker process). CODEACT_ENABLED=1 turns it on.
   */
  codeAct: {
    enabled: boolean;
    timeoutMs: number;
    maxCodeBytes: number;
    maxOutputBytes: number;
    maxCalls: number;
    maxResultBytes: number;
    maxConcurrency: number;
    callTimeoutMs: number;
    memoryMb: number;
    /** Nested calls waiting for a concurrency slot; more are refused at once. */
    maxQueuedCalls: number;
    /** One nested tool result larger than this is refused (not forwarded, not counted). */
    maxCallResultBytes: number;
    /** Protocol lines from the program (malformed ones included) before the execution is stopped. */
    maxProtocolMessages: number;
    /** listTools() calls per execution. */
    maxListTools: number;
  };
  /**
   * OS isolation of agent processes (bubblewrap). "off" = legacy trusted single-operator mode: agents run as the worker
   * user with the tool policy only; it is never reported as isolated and never authorizes unattended (AUTONOMOUS/AUTOPILOT)
   * work. "enforce" = every agent step runs in a sandbox (private HOME/tmp, hidden credentials and other runs, no network
   * except the provider egress allowlist, cgroup/rlimit limits); a host or provider that cannot do that fails closed.
   */
  isolation: {
    mode: "off" | "enforce";
    /** Exact host:port destinations each provider's sandbox may reach through the egress proxy. */
    egress: Record<string, string[]>;
    /** Extra read-only toolchain paths hidden by the private HOME (e.g. ~/go/pkg/mod). */
    readOnlyPaths: string[];
    /** Extra paths to hide from every sandbox. */
    extraMasks: string[];
    limits: {
      memoryMb: number;
      pids: number;
      cpuSeconds: number;
      fileSizeMb: number;
      openFiles: number;
    };
  };
  /**
   * Process supervision (ADR 0005, src/agent/process/supervisor.ts). "typescript": the platform spawns provider CLIs
   * and verification commands itself; "go": each runs under go/cmd/platform-supervise (delegated cgroup leaf,
   * cgroup.kill cleanup, host-wide admission). Set by PROCESS_SUPERVISION_ENGINE.
   */
  supervision: {
    engine: "typescript" | "go";
    /** Per-class limits applied by the Go engine (cgroup memory/pids/cpu, rlimits). 0 or absent = unlimited. */
    limits: Record<"agent" | "verification", Partial<SupervisionLimits>>;
    /** Host-wide concurrent processes per class (all instances of this account); 0 = no admission. */
    slots: Record<"agent" | "verification", number>;
    /** Defer a start while /proc/pressure/memory "some" avg10 exceeds this percentage (0 = never). */
    psiMemory: number;
    /** Defer a start while /proc/pressure/cpu "some" avg10 exceeds this percentage (0 = never). */
    psiCpu: number;
    /** Longest admission wait before the command is refused. */
    admissionTimeoutMs: number;
  };
  signoz: {
    defaultMinutes: number;
    maxMinutes: number;
    defaultLimit: number;
    maxLimit: number;
    timeoutMs: number;
    maxRetries: number;
    maxResponseBytes: number;
    /** SigNoz calls one workflow step may make (cache hits included: every call is recorded). */
    maxCallsPerStep: number;
    /** Self-hosted hosts on private networks an administrator approved; cloud metadata stays blocked regardless. */
    allowedInternalHosts: string[];
    /** Span attribute holding the namespace for the production error scan; unset = `deployment.environment`. */
    namespaceKey?: string;
  };
  /** Daily production error scan over Splunk (page "Lỗi production"). */
  prodErrors: {
    /** LOCAL explicit actor for the existing scheduled scan. Unset = manual scans only. */
    userId?: number;
    index: string;
    /** Kubernetes namespace → platform project (the project the "Điều tra" work item belongs to); `index` overrides the default index. */
    namespaces: Array<{ namespace: string; project: string; index?: string }>;
    timezone: string;
    /** Default scan times (HH:MM, local); editable on the page. */
    schedule: string[];
    timeoutSeconds: number;
    /** A request (root span) slower than this is counted in a SigNoz latency group; 0 disables latency groups. */
    slowThresholdMs: number;
  };
}

const isLoopback = (url: string | undefined, fallback: string) => {
  try {
    const u = new URL(url || fallback);
    // A Unix socket (?host=/path or an empty host) is local too.
    return (
      ["localhost", "127.0.0.1", "[::1]", ""].includes(u.hostname) ||
      (u.searchParams.get("host") ?? "").startsWith("/")
    );
  } catch {
    return false;
  }
};

/**
 * Host-wide memory budget of supervised processes (ADR 0005, reviewed in ADR 0007): the services this host runs keep
 * their share (Node 1 GiB, platform-go 512 MiB, a local PostgreSQL 1 GiB, a local Ollama embedding model 2 GiB); of
 * the rest, one agent or one verification command may take at most a third, and slots are counted so that the limits
 * of every slot of both classes together never exceed it — a full host cannot be overcommitted by its own caps.
 */
export function supervisionBudget(hostMb: number, cpus: number, env: NodeJS.ProcessEnv) {
  const reserved =
    1024 +
    512 +
    (isLoopback(env.DATABASE_URL, "postgres://localhost") ? 1024 : 0) +
    (env.RETRIEVAL_SEMANTIC_ENABLED === "true" &&
    (env.EMBEDDING_PROVIDER ?? "ollama") === "ollama" &&
    isLoopback(env.EMBEDDING_URL, "http://127.0.0.1:11434")
      ? 2048
      : 0);
  const workloadMb = Math.max(2048, hostMb - reserved);
  const agentMb = Math.min(4096, Math.floor(workloadMb / 3));
  const verifyMb = Math.min(6144, Math.floor(workloadMb / 3));
  const verification = Math.max(
    1,
    Math.min(Math.floor(cpus / 4), Math.floor(workloadMb / (2 * verifyMb))),
  );
  const agent = Math.max(
    1,
    Math.min(Math.floor(cpus / 2), Math.floor((workloadMb - verification * verifyMb) / agentMb)),
  );
  return { reservedMb: reserved, workloadMb, agentMb, verifyMb, slots: { agent, verification } };
}
const BUDGET = supervisionBudget(
  Math.floor(totalmem() / 1048576),
  availableParallelism(),
  process.env,
);

/**
 * Running platform (not the test suites): the platform-go engines, code intelligence and semantic retrieval are on by
 * default, so an installation needs no feature flags in .env. Each engine still falls back or rolls back with its
 * variable (`…_ENGINE=typescript`). Tests keep the TypeScript defaults and opt into Go per suite.
 */
const LIVE = process.env.PLATFORM_TEST !== "1";
const ENGINE = LIVE ? ("go" as const) : ("typescript" as const);

const defaults: Config = {
  knowledge: { ponytail: { enabled: false, mapChars: 2000 } },
  retrieval: {
    semantic: {
      enabled: LIVE,
      url: "http://127.0.0.1:4646",
      timeoutMs: 1500,
      topK: 30,
      minSimilarity: 0.45,
    },
  },
  analytics: { timeoutMs: 15000 },
  codeIntelligence: {
    enabled: LIVE,
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
  slop: {
    mode: "advisory",
    level: "auto",
    languages: { typescript: true, tsx: true, javascript: true, go: true },
    rules: {},
    thresholds: { cyclomatic: 15, cyclomaticHigh: 25, cognitive: 20, duplicateLines: 12 },
    minSeverity: "low",
    minConfidence: 0.8,
    blockSeverity: "high",
    excludePaths: [],
    suppressions: [],
    maxFiles: 200,
    timeoutMs: 20000,
  },
  evaluation: {
    enabled: false,
    maxCases: 20,
    maxRepetitions: 3,
    maxCaseSeconds: 1800,
    maxTokens: 3000000,
    maxCostUsd: 10,
    maxSuiteCostUsd: 300,
    liveEnabled: false,
    liveUsageProviders: ["claude", "antigravity", "copilot"],
    estimatedUsdPerMillion: 30,
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
  fileBaseUrl: "https://hr-media.hasaki.vn/production/hr",
  bitbucket: { workspace: "hasaki-tech", user: "", token: "", reviewers: [] },
  github: { allowSharedCredentials: false, accessVerification: "strict", token: "" },
  gitlab: {
    instances: [{ host: "gitlab.com" }],
    allowSharedCredentials: false,
    accessVerification: "strict",
    token: "",
    requestTimeoutMs: 30_000,
    maxRetries: 3,
  },
  platform: { repositoryUrl: "", trustedOperatorIsolation: false, testDatabaseAdminUrl: "" },
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
  costBudget: {
    runUsd: null,
    workItemUsd: null,
    warnPct: 0.8,
    action: "pause",
    unknownEstimate: "warn",
  },
  routing: { sensitiveProviders: [] },
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
  argocd: { baseUrl: "https://argocd-qc-v2.hasaki.dev" },
  vault: { baseUrl: "https://vault-qc-v2.hasaki.dev" },
  qcHttp: {
    hosts: [],
    internalHosts: [],
    productionDomains: ["hasaki.vn"],
    preauthorized: [],
    maxOperationsPerTurn: 5,
    timeoutMs: 20_000,
    maxBytes: 200_000,
    auth: {},
  },
  kafka: {
    baseUrl: "https://kafka-ui-qc-v2.hasaki.dev",
    cluster: "",
    maxMessages: 200,
    timeoutSeconds: 60,
    publishAllow: [],
  },
  splunk: {
    baseUrl: "https://siem.hasaki.work",
    managementUrl: "",
    locale: "en-US",
    allowedIndexes: [],
    maxMinutes: 7 * 24 * 60,
    maxResults: 500,
    timeoutSeconds: 60,
    environment: "production",
    timezone: "Asia/Ho_Chi_Minh",
    defaultIndexes: ["k8s_prod", "k8s_payment"],
    concurrency: 3,
    queryBudget: 25,
    allowSharedToken: false,
  },
  investigation: { maxRounds: 0 },
  prLifecycle: {
    mode: "off",
    pollSeconds: 300,
    maxRepairs: 2,
    trustedReviewers: [],
    botUsernames: [],
    requiredChecks: {},
  },
  lsp: {
    enabled: false,
    allowUnsandboxed: false,
    gopls: "",
    maxSessions: 4,
    idleMs: 300000,
    requestTimeoutMs: 15000,
    startupTimeoutMs: 30000,
    maxResults: 50,
  },
  codeAct: {
    enabled: false,
    timeoutMs: 20000,
    maxCodeBytes: 16384,
    maxOutputBytes: 16000,
    maxCalls: 20,
    maxResultBytes: 2000000,
    maxConcurrency: 4,
    callTimeoutMs: 15000,
    memoryMb: 256,
    maxQueuedCalls: 16,
    maxCallResultBytes: 1000000,
    maxProtocolMessages: 1000,
    maxListTools: 10,
  },
  isolation: {
    mode: "off",
    egress: { claude: ["api.anthropic.com:443"] },
    readOnlyPaths: [],
    extraMasks: [],
    limits: { memoryMb: 4096, pids: 512, cpuSeconds: 3600, fileSizeMb: 1024, openFiles: 4096 },
  },
  supervision: {
    engine: ENGINE,
    // Budgeted against this host (supervisionBudget): the services keep their share, and the limits of all slots of
    // both classes together stay within the rest. A cap is not a reservation; the memory-pressure gate also defers
    // starts when the host is actually short (and refuses them past the admission timeout).
    limits: {
      agent: { memoryMb: BUDGET.agentMb, pids: 4096 },
      verification: { memoryMb: BUDGET.verifyMb, pids: 8192, fileSizeMb: 4096 },
    },
    // e.g. 15.5 GiB / 16 CPUs with a remote database and a local Ollama: 12 GiB for workloads → 2 agents and 1
    // verification command at once, 4 GiB each.
    slots: { ...BUDGET.slots },
    psiMemory: 40,
    psiCpu: 0,
    admissionTimeoutMs: 10 * 60_000,
  },
  signoz: {
    defaultMinutes: 15,
    maxMinutes: 7 * 24 * 60,
    defaultLimit: 100,
    maxLimit: 1000,
    timeoutMs: 15_000,
    maxRetries: 2,
    maxResponseBytes: 2 * 1024 * 1024,
    maxCallsPerStep: 20,
    allowedInternalHosts: [],
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
      { namespace: "payment-prod", project: "Payment", index: "k8s_payment" },
    ],
    timezone: "Asia/Ho_Chi_Minh",
    schedule: ["09:00", "14:00", "17:00"],
    timeoutSeconds: 1800,
    slowThresholdMs: 1000,
  },
  learning: {
    detectChanges: true,
    maxRulesInPrompt: 20,
    maxSourceChars: 6000,
    evolveSkills: true,
    maxLessons: 3,
  },
  agent: {
    blockedModels: ["fable"],
    contextTokens: 24000,
    contextToolTimeoutMs: 10000,
    postSubmitGraceSeconds: 30,
    turnTimeoutMs: 45 * 60_000,
    idleTimeoutMs: 30 * 60_000,
    maxToolCalls: 400,
    settingSources: [],
    inlineKnowledgeTokens: 8000,
    knowledgeIndexSize: 12,
    upstreamTokens: 12000,
  },
};

export let instanceIdentityExplicit = false;

function load(): Config {
  // Operators configure through .env and the Settings page; PLATFORM_CONFIG is only for test/benchmark fixtures.
  const file = process.env.PLATFORM_CONFIG ? resolve(process.env.PLATFORM_CONFIG) : null;
  const fromFile = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const cfg: Config = {
    ...defaults,
    ...fromFile,
    knowledge: {
      ponytail: { ...defaults.knowledge.ponytail, ...(fromFile.knowledge?.ponytail ?? {}) },
    },
    retrieval: {
      semantic: { ...defaults.retrieval.semantic, ...(fromFile.retrieval?.semantic ?? {}) },
    },
    evaluation: { ...defaults.evaluation, ...(fromFile.evaluation ?? {}) },
    analytics: { ...defaults.analytics, ...(fromFile.analytics ?? {}) },
    supervision: {
      ...defaults.supervision,
      ...(fromFile.supervision ?? {}),
      limits: { ...defaults.supervision.limits, ...(fromFile.supervision?.limits ?? {}) },
      slots: { ...defaults.supervision.slots, ...(fromFile.supervision?.slots ?? {}) },
    },
    codeIntelligence: {
      ...defaults.codeIntelligence,
      ...(fromFile.codeIntelligence ?? {}),
      weights: {
        ...defaults.codeIntelligence.weights,
        ...(fromFile.codeIntelligence?.weights ?? {}),
      },
    },
    slop: {
      ...defaults.slop,
      ...(fromFile.slop ?? {}),
      languages: { ...defaults.slop.languages, ...(fromFile.slop?.languages ?? {}) },
      thresholds: { ...defaults.slop.thresholds, ...(fromFile.slop?.thresholds ?? {}) },
    },
    bitbucket: { ...defaults.bitbucket, ...(fromFile.bitbucket ?? {}) },
    github: { ...defaults.github, ...(fromFile.github ?? {}) },
    gitlab: gitlabConfig({ ...defaults.gitlab, ...(fromFile.gitlab ?? {}) }),
    platform: { ...defaults.platform, ...(fromFile.platform ?? {}) },
    hasakiWork: { ...defaults.hasakiWork, ...(fromFile.hasakiWork ?? {}) },
    scheduler: { ...defaults.scheduler, ...(fromFile.scheduler ?? {}) },
    instance: { ...defaults.instance, ...(fromFile.instance ?? {}) },
    argocd: { ...defaults.argocd, ...(fromFile.argocd ?? {}) },
    splunk: { ...defaults.splunk, ...(fromFile.splunk ?? {}) },
    investigation: { ...defaults.investigation, ...(fromFile.investigation ?? {}) },
    prLifecycle: { ...defaults.prLifecycle, ...(fromFile.prLifecycle ?? {}) },
    codeAct: { ...defaults.codeAct, ...(fromFile.codeAct ?? {}) },
    lsp: { ...defaults.lsp, ...(fromFile.lsp ?? {}) },
    isolation: {
      ...defaults.isolation,
      ...(fromFile.isolation ?? {}),
      limits: { ...defaults.isolation.limits, ...(fromFile.isolation?.limits ?? {}) },
      egress: { ...defaults.isolation.egress, ...(fromFile.isolation?.egress ?? {}) },
    },
    signoz: { ...defaults.signoz, ...(fromFile.signoz ?? {}) },
    kafka: { ...defaults.kafka, ...(fromFile.kafka ?? {}) },
    qcHttp: { ...defaults.qcHttp, ...(fromFile.qcHttp ?? {}) },
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
    !Number.isFinite(cfg.evaluation.estimatedUsdPerMillion) ||
    cfg.evaluation.estimatedUsdPerMillion <= 0 ||
    cfg.evaluation.estimatedUsdPerMillion > 1000
  )
    throw new Error("evaluation.estimatedUsdPerMillion must be positive and at most 1000");
  if (
    !Number.isFinite(cfg.evaluation.maxSuiteCostUsd) ||
    cfg.evaluation.maxSuiteCostUsd <= 0 ||
    cfg.evaluation.maxSuiteCostUsd > 1000
  )
    throw new Error("evaluation.maxSuiteCostUsd must be positive and at most 1000");
  if (!Number.isFinite(cfg.evaluation.maxCostUsd) || cfg.evaluation.maxCostUsd < 0)
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
    cfg.codeIntelligence[k] = positiveInt(`codeIntelligence.${k}`, cfg.codeIntelligence[k]);
  for (const v of Object.values(cfg.codeIntelligence.weights))
    if (!Number.isFinite(v) || v < 0) throw new Error("Invalid code intelligence weight");
  for (const k of ["maxFiles", "timeoutMs"] as const)
    cfg.slop[k] = positiveInt(`slop.${k}`, cfg.slop[k]);
  for (const [k, v] of Object.entries(cfg.slop.thresholds))
    cfg.slop.thresholds[k as keyof SlopSettings["thresholds"]] = positiveInt(
      `slop.thresholds.${k}`,
      v,
    );
  if (!["disabled", "advisory", "enforcement"].includes(cfg.slop.mode))
    throw new Error("slop.mode must be disabled, advisory or enforcement");
  if (!["postgresql", "generic"].includes(cfg.codeIntelligence.sqlDialect))
    throw new Error("Unsupported SQL dialect");
  if (process.env.PROCESS_SUPERVISION_ENGINE)
    cfg.supervision.engine = process.env
      .PROCESS_SUPERVISION_ENGINE as Config["supervision"]["engine"];
  if (!["typescript", "go"].includes(cfg.supervision.engine))
    throw new Error("PROCESS_SUPERVISION_ENGINE must be typescript or go");
  if (process.env.ANALYTICS_TIMEOUT_MS)
    cfg.analytics.timeoutMs = Number(process.env.ANALYTICS_TIMEOUT_MS);
  cfg.analytics.timeoutMs = positiveInt("analytics.timeoutMs", cfg.analytics.timeoutMs);
  if (process.env.CODEACT_ENABLED) cfg.codeAct.enabled = process.env.CODEACT_ENABLED === "1";
  if (process.env.LSP_ENABLED) cfg.lsp.enabled = process.env.LSP_ENABLED === "1";
  if (process.env.PROD_SLOW_THRESHOLD_MS)
    cfg.prodErrors.slowThresholdMs = Math.max(0, Number(process.env.PROD_SLOW_THRESHOLD_MS) || 0);
  if (process.env.IGNORE_REPOSITORIES)
    cfg.ignoredRepositories = process.env.IGNORE_REPOSITORIES.split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  const semantic = cfg.retrieval.semantic;
  if (process.env.RETRIEVAL_SEMANTIC_ENABLED)
    semantic.enabled = ["1", "true"].includes(process.env.RETRIEVAL_SEMANTIC_ENABLED);
  if (process.env.RETRIEVAL_SEMANTIC_URL) semantic.url = process.env.RETRIEVAL_SEMANTIC_URL;
  if (process.env.RETRIEVAL_SEMANTIC_TIMEOUT_MS)
    semantic.timeoutMs = Number(process.env.RETRIEVAL_SEMANTIC_TIMEOUT_MS);
  if (!/^https?:\/\//.test(semantic.url))
    throw new Error("retrieval.semantic.url must be an http(s) URL");
  semantic.timeoutMs = positiveInt("retrieval.semantic.timeoutMs", semantic.timeoutMs);
  semantic.topK = positiveInt("retrieval.semantic.topK", semantic.topK);
  if (semantic.topK > 100) throw new Error("retrieval.semantic.topK must be at most 100");
  if (
    !Number.isFinite(semantic.minSimilarity) ||
    semantic.minSimilarity < -1 ||
    semantic.minSimilarity > 1
  )
    throw new Error("retrieval.semantic.minSimilarity must be between -1 and 1");
  if (!cfg.scheduler.workers) cfg.scheduler.workers = cfg.maxConcurrent;
  // Git hosting credentials (Bitbucket, GitHub, GitLab) are personal secrets saved in Integrations: no BITBUCKET_*,
  // GITHUB_TOKEN or GITLAB_TOKEN is read. Telegram is configured on the Integrations page only (src/integrations/accounts.ts applies the saved bot token,
  // chat and mode onto this object at startup and when they change); no TELEGRAM_* variable is read.
  cfg.telegram = { ...defaults.telegram, mode: "off" };
  cfg.dataDir = resolve(cfg.dataDir);
  cfg.reposRoot = resolve(cfg.reposRoot);
  instanceIdentityExplicit = !!(process.env.PLATFORM_INSTANCE?.trim() || cfg.instanceId);
  cfg.instanceId = persistentInstanceId(
    cfg.dataDir,
    process.env.PLATFORM_INSTANCE?.trim() || cfg.instanceId,
  );
  cfg.instance.heartbeatSeconds = positiveInt(
    "instance.heartbeatSeconds",
    cfg.instance.heartbeatSeconds,
  );
  cfg.instance.offlineSeconds = positiveInt("instance.offlineSeconds", cfg.instance.offlineSeconds);
  if (cfg.instance.offlineSeconds <= cfg.instance.heartbeatSeconds * 2)
    throw new Error("instance.offlineSeconds must exceed twice heartbeatSeconds");
  for (const key of ["workers", "leaseSeconds", "heartbeatSeconds", "pollMs"] as const)
    cfg.scheduler[key] = positiveInt(`scheduler.${key}`, cfg.scheduler[key]);
  if (cfg.scheduler.heartbeatSeconds >= cfg.scheduler.leaseSeconds)
    throw new Error("scheduler heartbeat must be shorter than lease");
  if (!Number.isInteger(cfg.scheduler.lightWorkers) || cfg.scheduler.lightWorkers < 0)
    throw new Error("scheduler.lightWorkers must be nonnegative");
  const dbUrl = new URL(process.env.DATABASE_URL ?? cfg.databaseUrl);
  if (!["postgres:", "postgresql:"].includes(dbUrl.protocol))
    throw new Error("databaseUrl must use PostgreSQL");
  cfg.databaseUrl = process.env.DATABASE_URL ?? cfg.databaseUrl;
  cfg.database = {
    poolMax: positiveInt("database.poolMax", process.env.DATABASE_POOL_MAX ?? cfg.database.poolMax),
    poolMin: Math.max(0, Number(process.env.DATABASE_POOL_MIN ?? cfg.database.poolMin) || 0),
    connectionTimeoutMillis: positiveInt(
      "database.connectionTimeoutMillis",
      process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? cfg.database.connectionTimeoutMillis,
    ),
    idleTimeoutMillis: positiveInt(
      "database.idleTimeoutMillis",
      process.env.DATABASE_IDLE_TIMEOUT_MS ?? cfg.database.idleTimeoutMillis,
    ),
  };
  cfg.database.poolMin = Math.min(cfg.database.poolMin, cfg.database.poolMax);
  const sensitive = (process.env.ROUTING_SENSITIVE_PROVIDERS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  cfg.routing = {
    sensitiveProviders: sensitive.length
      ? sensitive
      : cfg.routing?.sensitiveProviders?.length
        ? cfg.routing.sensitiveProviders
        : [cfg.agent?.defaultProvider ?? "claude"],
  };
  const usd = (v: unknown) => (v == null || v === "" ? null : Number(v) > 0 ? Number(v) : null);
  const cb = { ...defaults.costBudget, ...(cfg.costBudget ?? {}) };
  cfg.costBudget = {
    runUsd: usd(process.env.COST_BUDGET_RUN_USD ?? cb.runUsd),
    workItemUsd: usd(process.env.COST_BUDGET_WORK_ITEM_USD ?? cb.workItemUsd),
    warnPct: Math.min(
      1,
      Math.max(0.1, Number(process.env.COST_BUDGET_WARN_PCT ?? cb.warnPct) || 0.8),
    ),
    action: (process.env.COST_BUDGET_ACTION ?? cb.action) === "warn" ? "warn" : "pause",
    unknownEstimate:
      (process.env.COST_BUDGET_UNKNOWN ?? cb.unknownEstimate) === "pause" ? "pause" : "warn",
  };
  // Secrets may come from env so config.json can be committed.
  if (process.env.PLATFORM_REPOSITORY_URL)
    cfg.platform.repositoryUrl = process.env.PLATFORM_REPOSITORY_URL;
  if (process.env.PLATFORM_TRUSTED_OPERATOR_ISOLATION === "1")
    cfg.platform.trustedOperatorIsolation = true;
  if (process.env.PLATFORM_TRUSTED_OPERATOR_ISOLATION === "0")
    cfg.platform.trustedOperatorIsolation = false;
  if (process.env.PLATFORM_TEST_DATABASE_ADMIN_URL)
    cfg.platform.testDatabaseAdminUrl = process.env.PLATFORM_TEST_DATABASE_ADMIN_URL;
  cfg.notifyWebhook = process.env.NOTIFY_WEBHOOK ?? cfg.notifyWebhook;
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (!cfg.publicUrl) cfg.publicUrl = `http://localhost:${cfg.port}`;
  mkdirSync(cfg.dataDir, { recursive: true });
  if (LIVE) {
    // The Claude CLI bundled with the Agent SDK (skips the SDK's per-query musl detection) unless one is configured.
    const bundled = join(import.meta.dirname, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64", "claude");
    if (!cfg.agent.claudeBin && !process.env.CLAUDE_CODE_EXECUTABLE && existsSync(bundled))
      cfg.agent.claudeBin = bundled;
    // The token between this server and platform-go: generated once per data directory (0600), not kept in .env.
    if (!process.env.RETRIEVAL_INTERNAL_TOKEN) {
      const file = join(cfg.dataDir, "internal-token");
      if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
      process.env.RETRIEVAL_INTERNAL_TOKEN = readFileSync(file, "utf8").trim();
    }
  }
  return cfg;
}

/** Positive integer from config.json or the environment. NaN, fractions, and values below 1 are rejected. */
/** Normalise the GitLab instance allow-list: bare lower-case host names only; anything else is dropped. */
export function gitlabConfig(raw: Config["gitlab"]): Config["gitlab"] {
  const seen = new Set<string>();
  const instances: GitlabInstance[] = [];
  for (const i of Array.isArray(raw.instances) ? raw.instances : []) {
    const host = String((i as GitlabInstance)?.host ?? "")
      .trim()
      .toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    const keys = (Array.isArray(i.sshHostKeys) ? i.sshHostKeys : [])
      .map((k) => SSH_HOST_KEY.exec(String(k).trim()))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => `${m[1]} ${m[2]}`);
    const port = Number(i.sshPort);
    instances.push({
      host,
      ...(i.caFile ? { caFile: String(i.caFile) } : {}),
      ...(keys.length ? { sshHostKeys: keys } : {}),
      ...(Number.isInteger(port) && port > 0 && port < 65536 && port !== 22
        ? { sshPort: port }
        : {}),
    });
  }
  return { ...raw, instances };
}

export function positiveInt(name: string, raw: unknown): number {
  if (typeof raw !== "number" && typeof raw !== "string")
    throw new Error(`${name} must be a positive integer`);
  const n = typeof raw === "number" ? raw : Number(raw.trim());
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
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
      bin: join(import.meta.dirname, "..", "test", "fixtures", "fake-codex.mjs"),
      timeoutMs: 15000,
      model: "gpt-test",
      reasoningEffort: "low",
      models: {},
    };
  const c = config.agent.codex ?? {};
  const timeout = Number(process.env.CODEX_TIMEOUT_MS || c.timeoutMs || 45 * 60 * 1000);
  return {
    bin: process.env.CODEX_BIN || c.bin || "codex",
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 45 * 60 * 1000,
    model: isOwned("codex.model") ? (c.model ?? "") : (process.env.CODEX_MODEL ?? c.model ?? ""),
    reasoningEffort: isOwned("codex.reasoningEffort")
      ? (c.reasoningEffort ?? "")
      : (process.env.CODEX_REASONING_EFFORT ?? c.reasoningEffort ?? ""),
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
    "bin" | "timeoutMs" | "model" | "effort" | "maxConcurrent" | "allowSubagents" | "sandbox"
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
  const maxConcurrent = isOwned("antigravity.maxConcurrent")
    ? Number(c.maxConcurrent)
    : Number(
        process.env.AGY_MAX_CONCURRENT ||
          process.env.ANTIGRAVITY_MAX_CONCURRENT ||
          c.maxConcurrent ||
          1,
      );
  return {
    bin: process.env.AGY_BIN || process.env.ANTIGRAVITY_BIN || c.bin || "agy",
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 45 * 60 * 1000,
    model: isOwned("antigravity.model")
      ? (c.model ?? "")
      : (process.env.AGY_MODEL ?? process.env.ANTIGRAVITY_MODEL ?? c.model ?? ""),
    effort: isOwned("antigravity.effort")
      ? (c.effort ?? "")
      : (process.env.AGY_EFFORT ?? process.env.ANTIGRAVITY_EFFORT ?? c.effort ?? ""),
    maxConcurrent: Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 1,
    allowSubagents:
      (process.env.AGY_ALLOW_SUBAGENTS ?? process.env.ANTIGRAVITY_ALLOW_SUBAGENTS)
        ? process.env.AGY_ALLOW_SUBAGENTS === "true" ||
          process.env.ANTIGRAVITY_ALLOW_SUBAGENTS === "true"
        : (c.allowSubagents ?? false),
    sandbox: isOwned("antigravity.sandbox")
      ? c.sandbox !== false
      : (process.env.AGY_SANDBOX ?? process.env.ANTIGRAVITY_SANDBOX)
        ? process.env.AGY_SANDBOX === "true" || process.env.ANTIGRAVITY_SANDBOX === "true"
        : (c.sandbox ?? true),
    models: c.models ?? {},
  };
}

export interface CopilotConfig {
  /** Executable. Empty uses `copilot` on PATH. */
  bin?: string;
  /** Hard limit for one Copilot turn (process). Default 45 minutes. */
  timeoutMs?: number;
  /** Copilot model slug (e.g. gpt-4o, claude-3.5-sonnet). Empty = the copilot default. */
  model?: string;
  /** Reasoning effort, e.g. low | medium | high | xhigh. Empty = model default. */
  effort?: string;
  /** Max concurrent Copilot turns on this worker (default 1). */
  maxConcurrent?: number;
  /** Allow subagents (default false). */
  allowSubagents?: boolean;
  /** Run in sandbox with restrictions (default true). */
  sandbox?: boolean;
  /** Same shape as agent.models (profile or "*" → step type or "verifier"), with Copilot model slugs only. */
  models?: Record<string, Record<string, string>>;
}

/** Copilot settings with env overrides applied. */
export function copilotConfig(): Required<
  Pick<
    CopilotConfig,
    "bin" | "timeoutMs" | "model" | "effort" | "maxConcurrent" | "allowSubagents" | "sandbox"
  >
> & { models: Record<string, Record<string, string>> } {
  if (execution.getStore()?.evaluation?.fixtureAgent)
    return {
      bin: join(import.meta.dirname, "..", "test", "fixtures", "fake-copilot.mjs"),
      timeoutMs: 15000,
      model: "gpt-test",
      effort: "medium",
      maxConcurrent: 1,
      allowSubagents: false,
      sandbox: true,
      models: {},
    };
  const c = config.agent.copilot ?? {};
  const timeout = Number(process.env.COPILOT_TIMEOUT_MS || c.timeoutMs || 45 * 60 * 1000);
  const maxConcurrent = isOwned("copilot.maxConcurrent")
    ? Number(c.maxConcurrent)
    : Number(process.env.COPILOT_MAX_CONCURRENT || c.maxConcurrent || 1);
  return {
    bin: process.env.COPILOT_BIN || c.bin || "copilot",
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 45 * 60 * 1000,
    model: isOwned("copilot.model")
      ? (c.model ?? "")
      : (process.env.COPILOT_MODEL ?? c.model ?? ""),
    effort: isOwned("copilot.effort")
      ? (c.effort ?? "")
      : (process.env.COPILOT_EFFORT ?? c.effort ?? ""),
    maxConcurrent: Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 1,
    allowSubagents: process.env.COPILOT_ALLOW_SUBAGENTS
      ? process.env.COPILOT_ALLOW_SUBAGENTS === "true"
      : (c.allowSubagents ?? false),
    sandbox: isOwned("copilot.sandbox")
      ? c.sandbox !== false
      : process.env.COPILOT_SANDBOX
        ? process.env.COPILOT_SANDBOX === "true"
        : (c.sandbox ?? true),
    models: c.models ?? {},
  };
}

export const config = load();

/** Evaluation overrides are per async execution, never shared mutable flags. */
export function codeIntelligenceEnabled() {
  return execution.getStore()?.evaluation?.codeIntelligence ?? config.codeIntelligence.enabled;
}
