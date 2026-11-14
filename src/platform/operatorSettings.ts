import { z } from "zod";
import { config } from "../config.ts";
import { settings } from "../db.ts";
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

const PROVIDERS = ["claude", "codex", "cursor", "antigravity"] as const;
const Provider = z.enum(PROVIDERS);
const Effort = z.enum(["", "low", "medium", "high", "xhigh"]);
const AgyEffort = z.enum(["", "low", "medium", "high", "xhigh", "max"]);

const Patch = z
  .object({
    model: z.string().max(200).optional(),
    maxTurns: z.number().int().min(1).max(500).optional(),
    defaultProvider: Provider.optional(),
    enabledProviders: z
      .object({
        claude: z.boolean().optional(),
        cursor: z.boolean().optional(),
        codex: z.boolean().optional(),
        antigravity: z.boolean().optional(),
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
        sensitiveProviders: z.array(Provider).max(4).optional(),
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
  const maxConcurrent = Number(
    process.env.AGY_MAX_CONCURRENT ||
      process.env.ANTIGRAVITY_MAX_CONCURRENT ||
      agy.maxConcurrent ||
      1,
  );
  fallback = {
    model: config.model ?? "",
    maxTurns: config.maxTurns,
    defaultProvider: config.agent.defaultProvider ?? "claude",
    enabledProviders: { ...(config.agent.enabledProviders ?? {}) },
    codex: {
      model: process.env.CODEX_MODEL ?? codex.model ?? "",
      reasoningEffort: (process.env.CODEX_REASONING_EFFORT ?? codex.reasoningEffort ?? "") as
        "" | "low" | "medium" | "high" | "xhigh",
    },
    antigravity: {
      model: process.env.AGY_MODEL ?? process.env.ANTIGRAVITY_MODEL ?? agy.model ?? "",
      effort: (process.env.AGY_EFFORT ?? process.env.ANTIGRAVITY_EFFORT ?? agy.effort ?? "") as
        "" | "low" | "medium" | "high" | "xhigh" | "max",
      sandbox: envFlag("AGY_SANDBOX", "ANTIGRAVITY_SANDBOX") ?? agy.sandbox ?? true,
      maxConcurrent:
        Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? Math.floor(maxConcurrent) : 1,
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
      maxTurns: config.maxTurns,
      defaultProvider: config.agent.defaultProvider ?? "claude",
      enabledProviders: {
        claude: config.agent.enabledProviders?.claude !== false,
        cursor: config.agent.enabledProviders?.cursor !== false,
        codex: config.agent.enabledProviders?.codex !== false,
        antigravity: config.agent.enabledProviders?.antigravity !== false,
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
  const flags = next.enabledProviders;
  if (flags && PROVIDERS.every((p) => flags[p] === false))
    throw new HttpError(400, "At least one agent provider must stay on");
  await settings.set(KEY, JSON.stringify(next));
  write(next);
  return operatorView();
}

export async function clearOperatorSettings() {
  await settings.set(KEY, "");
  write({});
  return operatorView();
}
