import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { copilotConfig } from "../../../config.ts";
import { agentEnvironment } from "../../environment.ts";
import { providerCapabilities } from "../../providerCapabilities.ts";
import { execution } from "../../../auth/execution.ts";

const exec = promisify(execFile);

export interface CopilotModel {
  slug: string;
  name: string;
  efforts: string[];
  default_effort?: string;
}

export interface CopilotCapability {
  ok: boolean;
  bin: string;
  version?: string;
  auth?: string;
  kind?: "missing" | "unsupported" | "auth" | "model";
  error?: string;
  models?: CopilotModel[];
}

/** Flags required by Copilot CLI ≥ 1.0 (stream-json / --input-format were removed). */
const REQUIRED_HELP = ["--output-format", "--prompt", "--model", "--silent", "--reasoning-effort"];
const NO_FALLBACK = "The platform will not fall back to Claude or another provider.";
const DEFAULT_EFFORTS = [...providerCapabilities("copilot").controls.efforts];

const FALLBACK_MODELS: CopilotModel[] = [
  { slug: "auto", name: "Auto", efforts: DEFAULT_EFFORTS, default_effort: "medium" },
  {
    slug: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    efforts: DEFAULT_EFFORTS,
    default_effort: "medium",
  },
  { slug: "gpt-4o", name: "GPT-4o", efforts: DEFAULT_EFFORTS, default_effort: "medium" },
  { slug: "gpt-4.1", name: "GPT-4.1", efforts: DEFAULT_EFFORTS, default_effort: "medium" },
  { slug: "o3", name: "o3", efforts: DEFAULT_EFFORTS, default_effort: "medium" },
  { slug: "o4-mini", name: "o4-mini", efforts: DEFAULT_EFFORTS, default_effort: "medium" },
  {
    slug: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    efforts: DEFAULT_EFFORTS,
    default_effort: "medium",
  },
  {
    slug: "claude-3.5-sonnet",
    name: "Claude 3.5 Sonnet",
    efforts: DEFAULT_EFFORTS,
    default_effort: "medium",
  },
];

let capCache: { key: string; at: number; value: CopilotCapability } | null = null;

export function resetCapabilitiesCache(): void {
  capCache = null;
}

export function copilotEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const out = agentEnvironment(base, "copilot");
  if (execution.getStore()?.evaluation?.fixtureAgent) {
    for (const k of Object.keys(out)) if (k.startsWith("FAKE_COPILOT_")) delete out[k];
    out.FAKE_COPILOT_MODE = "ok";
  }
  return { ...out, ...extra };
}

async function run(bin: string, args: string[], timeout = 20_000) {
  return exec(bin, args, {
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    env: copilotEnv(process.env),
  });
}

export async function copilotCapabilities(
  force = false,
  selection?: { model: string; effort: string },
): Promise<CopilotCapability> {
  const cfg = {
    ...copilotConfig(),
    ...(selection ? { model: selection.model, effort: selection.effort } : {}),
  };
  const key = `${cfg.bin}\u0000${cfg.model}\u0000${cfg.effort}\u0000${process.env.FAKE_COPILOT_MODE ?? ""}`;
  if (!force && capCache && capCache.key === key && Date.now() - capCache.at < 5 * 60_000)
    return capCache.value;
  const value = await probe(cfg.bin, cfg.model, cfg.effort);
  capCache = { key, at: Date.now(), value };
  return value;
}

/** Credential presence without spending a premium request. */
export function detectCopilotAuth(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  auth?: string;
} {
  // Fake CLI modes used by tests — do not inherit the developer's real Copilot login.
  if (env.FAKE_COPILOT_MODE === "logged-out") return { ok: false };
  if (env.COPILOT_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN)
    return { ok: true, auth: "Environment token" };
  const home = env.COPILOT_HOME || join(homedir(), ".copilot");
  for (const name of ["session-store.db", "config.json", "open-sessions-state.json"]) {
    try {
      const p = join(home, name);
      if (existsSync(p) && statSync(p).size > 0)
        return { ok: true, auth: "GitHub Account (Worker)" };
    } catch {
      /* ignore */
    }
  }
  const legacy = join(homedir(), ".config", "github-copilot", "hosts.json");
  try {
    if (existsSync(legacy) && statSync(legacy).size > 0)
      return { ok: true, auth: "GitHub Account (Worker)" };
  } catch {
    /* ignore */
  }
  return { ok: false };
}

async function probe(bin: string, model: string, effort: string): Promise<CopilotCapability> {
  let version = "";
  try {
    const v = await run(bin, ["--version"]);
    version = `${v.stdout}`.trim().split("\n")[0] ?? "";
  } catch (e: unknown) {
    const err = e as { code?: string; stderr?: string; message?: string } | null;
    if (err?.code === "ENOENT")
      return {
        ok: false,
        bin,
        kind: "missing",
        error: `GitHub Copilot CLI was not found (${bin}). Install it on the worker or set agent.copilot.bin / COPILOT_BIN, then run \`copilot login\`. ${NO_FALLBACK}`,
      };
    return {
      ok: false,
      bin,
      kind: "missing",
      error: `GitHub Copilot CLI (${bin}) failed to start: ${String(err?.stderr || err?.message || e).slice(0, 300)}. ${NO_FALLBACK}`,
    };
  }

  try {
    const help = await run(bin, ["--help"]);
    const text = `${help.stdout}\n${help.stderr}`;
    for (const f of REQUIRED_HELP) {
      if (!text.includes(f)) {
        return {
          ok: false,
          bin,
          version,
          kind: "unsupported",
          error: `${version || bin}: \`copilot\` does not support ${f}, which the platform needs for headless execution. Upgrade the GitHub Copilot CLI. ${NO_FALLBACK}`,
        };
      }
    }
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string } | null;
    return {
      ok: false,
      bin,
      version,
      kind: "unsupported",
      error: `${version || bin}: could not read \`copilot --help\`: ${String(err?.stderr || err?.message || e).slice(0, 300)}. ${NO_FALLBACK}`,
    };
  }

  const authState = detectCopilotAuth(process.env);
  const models = await modelCatalog(bin);
  if (!authState.ok && !models && !execution.getStore()?.evaluation?.fixtureAgent) {
    return {
      ok: false,
      bin,
      version,
      kind: "auth",
      error: `GitHub Copilot CLI on this worker is not logged in. Run \`copilot login\` (or set COPILOT_GITHUB_TOKEN / GH_TOKEN). ${NO_FALLBACK}`,
    };
  }

  const catalog = models?.length ? models : FALLBACK_MODELS;
  const cap: CopilotCapability = {
    ok: true,
    bin,
    version,
    auth: authState.auth ?? (models ? "Logged In" : "GitHub Account (Worker)"),
    models: catalog,
  };
  const problem = checkModel(catalog, model, effort);
  if (problem)
    return {
      ...cap,
      ok: false,
      kind: "model",
      error: `${problem} ${NO_FALLBACK}`,
    };
  return cap;
}

/**
 * Prefer the legacy `copilot models` subcommand when present (fake CLI / older builds).
 * CLI 1.0.114 removed it — callers fall back to FALLBACK_MODELS after auth detection.
 */
export async function modelCatalog(bin: string): Promise<CopilotModel[] | null> {
  try {
    const r = await run(bin, ["models"], 15_000);
    const stdout = r.stdout;
    const lines = stdout.split("\n");
    const models: CopilotModel[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (
        !line ||
        line.startsWith("Usage") ||
        line.startsWith("List available") ||
        line.startsWith("Flags:") ||
        line.includes("Fetching available models") ||
        line.startsWith("error:") ||
        line.startsWith("Did you mean")
      )
        continue;
      const match = line.match(/^([a-zA-Z0-9_.-]+)(?:\s+(.+))?$/);
      if (match) {
        const slug = match[1];
        const name = (match[2] || slug).trim();
        models.push({
          slug,
          name,
          efforts: DEFAULT_EFFORTS,
          default_effort: "medium",
        });
      }
    }
    if (!models.some((m) => m.slug === "auto"))
      models.unshift({
        slug: "auto",
        name: "Auto",
        efforts: DEFAULT_EFFORTS,
        default_effort: "medium",
      });
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

export function checkModel(models: CopilotModel[], model: string, effort: string): string | null {
  if (!models.length) return null;
  if (!model || model === "auto") {
    /* auto is always acceptable when present or when using Fusion routing */
  } else {
    const m = models.find((x) => x.slug === model || x.name === model);
    // Unknown slugs are allowed through — the CLI rejects them at runtime. Catalogs lag Fusion.
    if (!m && !models.some((x) => x.slug === "auto")) {
      return `Copilot model "${model}" is not available to the worker's account (available: ${models.map((x) => x.slug).join(", ")}).`;
    }
  }
  const supportedEfforts = providerCapabilities("copilot").controls.efforts;
  if (effort && !supportedEfforts.includes(effort)) {
    return `Copilot does not support reasoning effort "${effort}" (supported: ${supportedEfforts.join(", ")}).`;
  }
  return null;
}
