import { z } from "zod";
import { config, gitlabConfig, SSH_HOST_KEY } from "../config.ts";
import { settings } from "../db.ts";
import { one, q, withTx } from "../db/pool.ts";
import { importLegacyAgentPatch } from "../agent/configurationStore.ts";
import { HttpError } from "../http/error.ts";
import { clearOwned, own } from "./operatorState.ts";

/**
 * Operator policy edited on the Settings page and stored in `settings` (key `operator`).
 *
 * A saved value wins over config.json and the environment. Clearing the page restores whatever
 * config.json / the environment supplied at process start. DATABASE_URL stays in the environment:
 * the process cannot reach this table without it. Tokens stay on the Integrations page.
 * Machine paths (dataDir, reposRoot, ports, CLI binaries) stay local because each workstation differs.
 */

const PROVIDERS = ["claude", "codex", "cursor", "antigravity", "copilot"] as const;
const Provider = z.enum(PROVIDERS);
const Effort = z.enum(["", "low", "medium", "high", "xhigh"]);
const AgyEffort = z.enum(["", "low", "medium", "high", "xhigh", "max"]);
/** Claude model per execution profile ("*" = any) and step role, same shape as config.agent.models. */
const Models = z.partialRecord(
  z.enum(["*", "MICRO", "FAST", "STANDARD", "DEEP"]),
  z.partialRecord(z.enum(["agent", "coding_agent", "verifier"]), z.string().trim().min(1).max(200)),
);

const Patch = z
  .object({
    model: z.string().max(200).optional(),
    models: Models.optional(),
    fileBaseUrl: z.union([z.literal(""), z.url().max(500)]).optional(),
    relatedProjects: z
      .record(z.string().trim().min(1).max(80), z.array(z.string().trim().min(1).max(80)).max(50))
      .optional(),
    bitbucketAccess: z.enum(["strict", "personal", "trusted"]).optional(),
    gitlabInstances: z
      .array(
        z
          .object({
            host: z
              .string()
              .trim()
              .toLowerCase()
              .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "GitLab host must be a bare host name, e.g. gitlab.example.com"),
            sshPort: z.number().int().min(1).max(65535).optional(),
            sshHostKeys: z.array(z.string().trim().regex(SSH_HOST_KEY, "not an OpenSSH public host key")).max(10).optional(),
            caFile: z.string().trim().max(500).optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    maxTurns: z.number().int().min(1).max(500).optional(),
    defaultProvider: Provider.optional(),
    enabledProviders: z
      .object({
        claude: z.boolean().optional(),
        cursor: z.boolean().optional(),
        codex: z.boolean().optional(),
        antigravity: z.boolean().optional(),
        copilot: z.boolean().optional(),
      })
      .strict()
      .optional(),
    codex: z
      .object({
        model: z.string().max(200).optional(),
        reasoningEffort: Effort.optional(),
      })
      .strict()
      .optional(),
    antigravity: z
      .object({
        model: z.string().max(200).optional(),
        effort: AgyEffort.optional(),
        sandbox: z.boolean().optional(),
        maxConcurrent: z.number().int().min(1).max(8).optional(),
      })
      .strict()
      .optional(),
    copilot: z
      .object({
        model: z.string().max(200).optional(),
        effort: Effort.optional(),
        sandbox: z.boolean().optional(),
        maxConcurrent: z.number().int().min(1).max(8).optional(),
      })
      .strict()
      .optional(),
    costBudget: z
      .object({
        runUsd: z.number().positive().max(1_000_000).nullable().optional(),
        workItemUsd: z.number().positive().max(1_000_000).nullable().optional(),
        warnPct: z.number().min(0.1).max(1).optional(),
        action: z.enum(["pause", "warn"]).optional(),
        unknownEstimate: z.enum(["warn", "pause"]).optional(),
      })
      .strict()
      .optional(),
    scheduler: z
      .object({
        workers: z.number().int().min(1).max(32).optional(),
        lightWorkers: z.number().int().min(0).max(16).optional(),
      })
      .strict()
      .optional(),
    routing: z
      .object({
        sensitiveProviders: z.array(Provider).max(5).optional(),
      })
      .strict()
      .optional(),
    hasakiWork: z
      .object({
        pollMinutes: z
          .number()
          .int()
          .min(0)
          .max(24 * 60)
          .optional(),
        autoPick: z.boolean().optional(),
        autoWorkflow: z.string().max(80).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type OperatorPatch = z.infer<typeof Patch>;

const KEY = "operator";

let fallback: OperatorPatch | null = null;
let saved: OperatorPatch = {};

function envFlag(name: string, alt: string): boolean | undefined {
  const raw = process.env[name] ?? process.env[alt];
  if (raw == null || raw === "") return undefined;
  return raw === "true";
}

/** What config.json and the environment resolved to, captured once before any Settings overlay. */
export function captureOperatorFallback(): OperatorPatch {
  if (fallback) return fallback;
  const codex = config.agent.codex ?? {};
  const agy = config.agent.antigravity ?? {};
  const copilot = config.agent.copilot ?? {};
  const maxConcurrent = Number(
    process.env.AGY_MAX_CONCURRENT ||
      process.env.ANTIGRAVITY_MAX_CONCURRENT ||
      agy.maxConcurrent ||
      1,
  );
  const copilotConcurrent = Number(
    process.env.COPILOT_MAX_CONCURRENT || copilot.maxConcurrent || 1,
  );
  const copilotSandbox = process.env.COPILOT_SANDBOX;
  fallback = {
    model: config.model ?? "",
    models: structuredClone(config.agent.models ?? {}) as OperatorPatch["models"],
    fileBaseUrl: config.fileBaseUrl ?? "",
    relatedProjects: structuredClone(config.relatedProjects ?? {}),
    bitbucketAccess: config.bitbucket.accessVerification ?? "strict",
    gitlabInstances: structuredClone(config.gitlab.instances),
    maxTurns: config.maxTurns,
    defaultProvider: config.agent.defaultProvider ?? "claude",
    enabledProviders: { ...(config.agent.enabledProviders ?? {}) },
    codex: {
      model: process.env.CODEX_MODEL ?? codex.model ?? "",
      reasoningEffort: (process.env.CODEX_REASONING_EFFORT ?? codex.reasoningEffort ?? "") as
        | ""
        | "low"
        | "medium"
        | "high"
        | "xhigh",
    },
    antigravity: {
      model: process.env.AGY_MODEL ?? process.env.ANTIGRAVITY_MODEL ?? agy.model ?? "",
      effort: (process.env.AGY_EFFORT ?? process.env.ANTIGRAVITY_EFFORT ?? agy.effort ?? "") as
        | ""
        | "low"
        | "medium"
        | "high"
        | "xhigh"
        | "max",
      sandbox: envFlag("AGY_SANDBOX", "ANTIGRAVITY_SANDBOX") ?? agy.sandbox ?? true,
      maxConcurrent:
        Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? Math.floor(maxConcurrent) : 1,
    },
    copilot: {
      model: process.env.COPILOT_MODEL ?? copilot.model ?? "",
      effort: (process.env.COPILOT_EFFORT ?? copilot.effort ?? "") as
        | ""
        | "low"
        | "medium"
        | "high"
        | "xhigh",
      sandbox:
        copilotSandbox === "true"
          ? true
          : copilotSandbox === "false"
            ? false
            : (copilot.sandbox ?? true),
      maxConcurrent:
        Number.isFinite(copilotConcurrent) && copilotConcurrent > 0
          ? Math.floor(copilotConcurrent)
          : 1,
    },
    costBudget: {
      runUsd: config.costBudget.runUsd,
      workItemUsd: config.costBudget.workItemUsd,
      warnPct: config.costBudget.warnPct,
      action: config.costBudget.action,
      unknownEstimate: config.costBudget.unknownEstimate,
    },
    scheduler: {
      workers: config.scheduler.workers,
      lightWorkers: config.scheduler.lightWorkers,
    },
    routing: {
      sensitiveProviders: config.routing.sensitiveProviders.filter(
        (p): p is (typeof PROVIDERS)[number] => (PROVIDERS as readonly string[]).includes(p),
      ),
    },
    hasakiWork: {
      pollMinutes: config.hasakiWork.pollMinutes,
      autoPick: config.hasakiWork.autoPick,
      autoWorkflow: config.hasakiWork.autoWorkflow,
    },
  };
  return fallback;
}

function pick<T>(section: object | undefined, key: string, fb: T): T {
  if (section && Object.prototype.hasOwnProperty.call(section, key))
    return (section as Record<string, T>)[key];
  return fb;
}

function write(next: OperatorPatch) {
  const fb = captureOperatorFallback();
  saved = next;
  clearOwned();
  config.model = pick(next, "model", fb.model ?? "");
  own("model", Object.prototype.hasOwnProperty.call(next, "model"));
  config.agent.models = structuredClone(pick(next, "models", fb.models ?? {})) as Record<
    string,
    Record<string, string>
  >;
  own("models", Object.prototype.hasOwnProperty.call(next, "models"));
  config.fileBaseUrl = pick(next, "fileBaseUrl", "") || fb.fileBaseUrl || "";
  config.relatedProjects = structuredClone(pick(next, "relatedProjects", fb.relatedProjects ?? {}));
  config.bitbucket.accessVerification = pick(next, "bitbucketAccess", fb.bitbucketAccess ?? "strict");
  config.gitlab = gitlabConfig({
    ...config.gitlab,
    instances: structuredClone(pick(next, "gitlabInstances", fb.gitlabInstances ?? [])),
  });
  config.maxTurns = pick(next, "maxTurns", fb.maxTurns ?? config.maxTurns);
  own("maxTurns", Object.prototype.hasOwnProperty.call(next, "maxTurns"));
  const flags = pick(next, "enabledProviders", fb.enabledProviders);
  config.agent.enabledProviders = flags;
  own("enabledProviders", Object.prototype.hasOwnProperty.call(next, "enabledProviders"));
  let defaultProvider = pick(next, "defaultProvider", fb.defaultProvider ?? "claude");
  if (flags?.[defaultProvider] === false) {
    defaultProvider = PROVIDERS.find((p) => flags[p] !== false) ?? defaultProvider;
  }
  config.agent.defaultProvider = defaultProvider;
  own("defaultProvider", Object.prototype.hasOwnProperty.call(next, "defaultProvider"));

  const codexFb = fb.codex ?? {};
  config.agent.codex = {
    ...(config.agent.codex ?? {}),
    model: pick(next.codex, "model", codexFb.model ?? ""),
    reasoningEffort: pick(next.codex, "reasoningEffort", codexFb.reasoningEffort ?? ""),
  };
  own("codex.model", !!next.codex && Object.prototype.hasOwnProperty.call(next.codex, "model"));
  own(
    "codex.reasoningEffort",
    !!next.codex && Object.prototype.hasOwnProperty.call(next.codex, "reasoningEffort"),
  );

  const agyFb = fb.antigravity ?? {};
  config.agent.antigravity = {
    ...(config.agent.antigravity ?? {}),
    model: pick(next.antigravity, "model", agyFb.model ?? ""),
    effort: pick(next.antigravity, "effort", agyFb.effort ?? ""),
    sandbox: pick(next.antigravity, "sandbox", agyFb.sandbox ?? true),
    maxConcurrent: pick(next.antigravity, "maxConcurrent", agyFb.maxConcurrent ?? 1),
  };
  for (const key of ["model", "effort", "sandbox", "maxConcurrent"] as const)
    own(
      `antigravity.${key}`,
      !!next.antigravity && Object.prototype.hasOwnProperty.call(next.antigravity, key),
    );

  const copilotFb = fb.copilot ?? {};
  config.agent.copilot = {
    ...(config.agent.copilot ?? {}),
    model: pick(next.copilot, "model", copilotFb.model ?? ""),
    effort: pick(next.copilot, "effort", copilotFb.effort ?? ""),
    sandbox: pick(next.copilot, "sandbox", copilotFb.sandbox ?? true),
    maxConcurrent: pick(next.copilot, "maxConcurrent", copilotFb.maxConcurrent ?? 1),
  };
  for (const key of ["model", "effort", "sandbox", "maxConcurrent"] as const)
    own(
      `copilot.${key}`,
      !!next.copilot && Object.prototype.hasOwnProperty.call(next.copilot, key),
    );

  const costFb = fb.costBudget ?? {};
  config.costBudget = {
    ...config.costBudget,
    runUsd: pick(next.costBudget, "runUsd", costFb.runUsd ?? null),
    workItemUsd: pick(next.costBudget, "workItemUsd", costFb.workItemUsd ?? null),
    warnPct: pick(next.costBudget, "warnPct", costFb.warnPct ?? config.costBudget.warnPct),
    action: pick(next.costBudget, "action", costFb.action ?? config.costBudget.action),
    unknownEstimate: pick(
      next.costBudget,
      "unknownEstimate",
      costFb.unknownEstimate ?? config.costBudget.unknownEstimate,
    ),
  };
  const schedFb = fb.scheduler ?? {};
  config.scheduler.workers = pick(
    next.scheduler,
    "workers",
    schedFb.workers ?? config.scheduler.workers,
  );
  config.scheduler.lightWorkers = pick(
    next.scheduler,
    "lightWorkers",
    schedFb.lightWorkers ?? config.scheduler.lightWorkers,
  );
  const routeFb = fb.routing?.sensitiveProviders ?? config.routing.sensitiveProviders;
  config.routing.sensitiveProviders = pick(next.routing, "sensitiveProviders", [...routeFb]);
  const workFb = fb.hasakiWork ?? {};
  config.hasakiWork.pollMinutes = pick(
    next.hasakiWork,
    "pollMinutes",
    workFb.pollMinutes ?? config.hasakiWork.pollMinutes,
  );
  config.hasakiWork.autoPick = pick(
    next.hasakiWork,
    "autoPick",
    workFb.autoPick ?? config.hasakiWork.autoPick,
  );
  config.hasakiWork.autoWorkflow = pick(
    next.hasakiWork,
    "autoWorkflow",
    workFb.autoWorkflow ?? config.hasakiWork.autoWorkflow,
  );
}

export function applyOperator(next: OperatorPatch) {
  write(next);
}

export function resetOperatorForTests() {
  fallback = null;
  saved = {};
  clearOwned();
}

export function operatorView() {
  const fb = captureOperatorFallback();
  return {
    saved,
    fallback: fb,
    effective: {
      model: config.model,
      models: config.agent.models ?? {},
      fileBaseUrl: config.fileBaseUrl ?? "",
      relatedProjects: config.relatedProjects ?? {},
      bitbucketAccess: config.bitbucket.accessVerification ?? "strict",
      gitlabInstances: config.gitlab.instances,
      maxTurns: config.maxTurns,
      defaultProvider: config.agent.defaultProvider ?? "claude",
      enabledProviders: {
        claude: config.agent.enabledProviders?.claude !== false,
        cursor: config.agent.enabledProviders?.cursor !== false,
        codex: config.agent.enabledProviders?.codex !== false,
        antigravity: config.agent.enabledProviders?.antigravity !== false,
        copilot: config.agent.enabledProviders?.copilot !== false,
      },
      codex: {
        model: config.agent.codex?.model ?? "",
        reasoningEffort: config.agent.codex?.reasoningEffort ?? "",
      },
      antigravity: {
        model: config.agent.antigravity?.model ?? "",
        effort: config.agent.antigravity?.effort ?? "",
        sandbox: config.agent.antigravity?.sandbox ?? true,
        maxConcurrent: config.agent.antigravity?.maxConcurrent ?? 1,
      },
      copilot: {
        model: config.agent.copilot?.model ?? "",
        effort: config.agent.copilot?.effort ?? "",
        sandbox: config.agent.copilot?.sandbox ?? true,
        maxConcurrent: config.agent.copilot?.maxConcurrent ?? 1,
      },
      costBudget: config.costBudget,
      scheduler: {
        workers: config.scheduler.workers,
        lightWorkers: config.scheduler.lightWorkers,
      },
      routing: { sensitiveProviders: config.routing.sensitiveProviders },
      hasakiWork: {
        pollMinutes: config.hasakiWork.pollMinutes,
        autoPick: config.hasakiWork.autoPick,
        autoWorkflow: config.hasakiWork.autoWorkflow,
      },
    },
    /** Worker loops are created at process start. */
    restart: ["scheduler.workers", "scheduler.lightWorkers"],
  };
}

function parse(raw: unknown): OperatorPatch {
  const parsed = Patch.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new HttpError(400, msg || "invalid settings");
  }
  return parsed.data;
}

export async function loadOperatorSettings() {
  captureOperatorFallback();
  const raw = await settings.get(KEY);
  if (!raw) {
    write({});
    return;
  }
  try {
    write(parse(JSON.parse(raw)));
  } catch (e) {
    if (e instanceof HttpError) {
      console.warn(`operator settings ignored: ${e.message}`);
      write({});
      return;
    }
    write({});
  }
}

export async function saveOperatorSettings(raw: unknown) {
  const next = parse(raw ?? {});
  // GitLab instances are managed on Integrations; a Settings page save that omits them must not drop them.
  if (!Object.prototype.hasOwnProperty.call(next, "gitlabInstances") && saved.gitlabInstances)
    next.gitlabInstances = saved.gitlabInstances;
  const flags = next.enabledProviders;
  if (flags && PROVIDERS.every((p) => flags[p] === false))
    throw new HttpError(400, "At least one agent provider must stay on");
  await withTx(async (db) => {
    const previous = await one<{ value: string }>(db, "SELECT value FROM settings WHERE key=$1 FOR UPDATE", [KEY]);
    const old = previous?.value ? JSON.parse(previous.value) : {};
    const patch: Record<string, unknown> = {};
    for (const key of ["model", "models", "maxTurns", "defaultProvider", "enabledProviders", "codex", "antigravity", "copilot"] as const)
      if (Object.hasOwn(next, key) && JSON.stringify(next[key]) !== JSON.stringify(old[key])) patch[key] = next[key];
    if (Object.keys(patch).length) await importLegacyAgentPatch(db, patch);
    await q(db, "INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [KEY, JSON.stringify(next)]);
  });
  write(next);
  return operatorView();
}

export async function clearOperatorSettings() {
  // Restoring Settings defaults leaves the GitLab instances added on Integrations in place.
  const keep: OperatorPatch = saved.gitlabInstances ? { gitlabInstances: saved.gitlabInstances } : {};
  await settings.set(KEY, Object.keys(keep).length ? JSON.stringify(keep) : "");
  write(keep);
  return operatorView();
}

/** "http://gitlab.example.com:8443/group/" → "gitlab.example.com". Git and the API always use HTTPS on that host. */
export function gitlabHostFrom(input: unknown): string {
  const host = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^[^@/]*@/, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host))
    throw new HttpError(400, "Enter a GitLab host or URL, e.g. gitlab.example.com");
  return host;
}

/** Allow-list one GitLab host (stored with the other operator settings, never in config.json). */
export async function addGitlabInstance(input: unknown) {
  const host = gitlabHostFrom(input);
  const current = saved.gitlabInstances ?? structuredClone(config.gitlab.instances);
  if (current.some((i) => i.host === host)) return operatorView();
  return saveOperatorSettings({ ...saved, gitlabInstances: [...current, { host }] });
}

export async function removeGitlabInstance(input: unknown) {
  const host = gitlabHostFrom(input);
  const current = saved.gitlabInstances ?? structuredClone(config.gitlab.instances);
  return saveOperatorSettings({ ...saved, gitlabInstances: current.filter((i) => i.host !== host) });
}
