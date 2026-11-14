import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { copilotConfig } from "../../config.ts";
import { agentEnvironment } from "../environment.ts";
import { execution } from "../../auth/execution.ts";

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

const REQUIRED_FLAGS = [
  "--output-format",
  "--input-format",
  "--model",
];
const NO_FALLBACK = "The platform will not fall back to Claude or another provider.";

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
        error: `GitHub Copilot CLI was not found (${bin}). Install it on the worker or set agent.copilot.bin / COPILOT_BIN, then run \`copilot auth login\`. ${NO_FALLBACK}`,
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
    for (const f of REQUIRED_FLAGS) {
      if (!text.includes(f)) {
        return {
          ok: false,
          bin,
          version,
          kind: "unsupported",
          error: `${version || bin}: \`copilot\` does not support ${f}, which the platform needs to enforce its execution policy. Upgrade the GitHub Copilot CLI. ${NO_FALLBACK}`,
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

  // Detect worker authentication status: config token file presence or model listing success
  const tokenFile = join(homedir(), ".config", "github-copilot", "hosts.json");
  let hasToken = false;
  try {
    hasToken = existsSync(tokenFile) && statSync(tokenFile).size > 0;
  } catch { /* ignore */ }

  const models = await modelCatalog(bin);
  if (!models && !execution.getStore()?.evaluation?.fixtureAgent) {
    return {
      ok: false,
      bin,
      version,
      kind: "auth",
      error: `GitHub Copilot CLI on this worker is not logged in. Run \`copilot auth login\` on the worker machine to authenticate. ${NO_FALLBACK}`,
    };
  }

  const auth = hasToken ? "GitHub Account (Worker)" : "Logged In";
  const cap: CopilotCapability = {
    ok: true,
    bin,
    version,
    auth,
    models: models ?? undefined,
  };
  const problem = models ? checkModel(models, model, effort) : null;
  if (problem)
    return {
      ...cap,
      ok: false,
      kind: "model",
      error: `${problem} ${NO_FALLBACK}`,
    };
  return cap;
}

export async function modelCatalog(bin: string): Promise<CopilotModel[] | null> {
  try {
    const r = await run(bin, ["models"], 30_000);
    const stdout = r.stdout;
    const lines = stdout.split("\n");
    const models: CopilotModel[] = [];
    const supportedEfforts = ["low", "medium", "high", "xhigh"];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (
        !line ||
        line.startsWith("Usage") ||
        line.startsWith("List available") ||
        line.startsWith("Flags:") ||
        line.includes("Fetching available models")
      )
        continue;
      // Format is: `<slug>    <Human Readable Name>` or simply `<slug>`
      const match = line.match(/^([a-zA-Z0-9_.-]+)(?:\s+(.+))?$/);
      if (match) {
        const slug = match[1];
        const name = (match[2] || slug).trim();
        models.push({
          slug,
          name,
          efforts: supportedEfforts,
          default_effort: "medium",
        });
      }
    }
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

export function checkModel(
  models: CopilotModel[],
  model: string,
  effort: string,
): string | null {
  if (!models.length) return null;
  const m = model ? models.find((x) => x.slug === model || x.name === model) : null;
  if (model && !m) {
    return `Copilot model "${model}" is not available to the worker's account (available: ${models.map((x) => x.slug).join(", ")}).`;
  }
  const supportedEfforts = ["low", "medium", "high", "xhigh"];
  if (effort && !supportedEfforts.includes(effort)) {
    return `Copilot does not support reasoning effort "${effort}" (supported: ${supportedEfforts.join(", ")}).`;
  }
  return null;
}
