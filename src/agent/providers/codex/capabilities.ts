import { execFile, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";
import { execution } from "../../../auth/execution.ts";
import { codexConfig } from "../../../config.ts";
import { agentEnvironment } from "../../environment.ts";

const exec = promisify(execFile);

export interface CodexCapability {
  ok: boolean;
  bin: string;
  version?: string;
  /** Text after "Logged in using", e.g. "ChatGPT". Never a credential. */
  auth?: string;
  kind?: "missing" | "unsupported" | "auth" | "model";
  error?: string;
  models?: Array<{ slug: string; efforts: string[]; default_effort?: string }>;
}

const REQUIRED_EXEC_FLAGS = [
  "--json",
  "--strict-config",
  "--ignore-user-config",
  "--ignore-rules",
  "--dangerously-bypass-hook-trust",
  "--skip-git-repo-check",
  "--config",
];
const REQUIRED_RESUME_FLAGS = [
  "--json",
  "--strict-config",
  "--ignore-user-config",
  "--ignore-rules",
  "--dangerously-bypass-hook-trust",
  "--config",
];
const NO_FALLBACK = "The platform will not fall back to Claude or another provider.";

let capCache: { key: string; at: number; value: CodexCapability } | null = null;

/** Environment for every Codex child: no platform secrets, no API keys (no silent switch to API billing). */
export function codexEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const out = agentEnvironment(base, "codex");
  if (execution.getStore()?.evaluation?.fixtureAgent) {
    for (const k of Object.keys(out)) if (k.startsWith("FAKE_CODEX_")) delete out[k];
    out.FAKE_CODEX_MODE = "ok";
  }
  return { ...out, ...extra };
}

async function run(bin: string, args: string[], timeout = 20_000) {
  return exec(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024, env: codexEnv(process.env) });
}

/**
 * Probe the installed CLI without calling a model: version, required flags, login status (`codex login status`),
 * and the model catalog (`codex debug models`) to validate the configured model and reasoning effort.
 */
export async function codexCapabilities(
  force = false,
  selection?: { model: string; effort: string },
): Promise<CodexCapability> {
  const cfg = {
    ...codexConfig(),
    ...(selection ? { model: selection.model, reasoningEffort: selection.effort } : {}),
  };
  const key = `${cfg.bin}\u0000${cfg.model}\u0000${cfg.reasoningEffort}`;
  if (!force && capCache && capCache.key === key && Date.now() - capCache.at < 5 * 60_000)
    return capCache.value;
  const value = await probe(cfg.bin, cfg.model, cfg.reasoningEffort);
  capCache = { key, at: Date.now(), value };
  return value;
}

async function probe(bin: string, model: string, effort: string): Promise<CodexCapability> {
  let version = "";
  try {
    const v = await run(bin, ["--version"]);
    version = `${v.stdout}`.trim().split("\n")[0] ?? "";
  } catch (caught) {
    const e = caught as ExecFileException;
    if (e?.code === "ENOENT")
      return {
        ok: false,
        bin,
        kind: "missing",
        error: `Codex CLI was not found (${bin}). Install it on the worker (npm i -g @openai/codex) or set agent.codex.bin / CODEX_BIN, then run \`codex login\`. ${NO_FALLBACK}`,
      };
    return {
      ok: false,
      bin,
      kind: "missing",
      error: `Codex CLI (${bin}) failed to start: ${String(e?.stderr || e?.message || e).slice(0, 300)}. ${NO_FALLBACK}`,
    };
  }
  try {
    const help = await run(bin, ["exec", "--help"]);
    const text = `${help.stdout}\n${help.stderr}`;
    for (const f of REQUIRED_EXEC_FLAGS)
      if (!text.includes(f))
        return {
          ok: false,
          bin,
          version,
          kind: "unsupported",
          error: `${version || bin}: \`codex exec\` does not support ${f}, which the platform needs to enforce its execution policy. Upgrade the Codex CLI. ${NO_FALLBACK}`,
        };
    const rhelp = await run(bin, ["exec", "resume", "--help"]);
    const rtext = `${rhelp.stdout}\n${rhelp.stderr}`;
    for (const f of REQUIRED_RESUME_FLAGS)
      if (!rtext.includes(f))
        return {
          ok: false,
          bin,
          version,
          kind: "unsupported",
          error: `${version || bin}: \`codex exec resume\` does not support ${f}. Upgrade the Codex CLI. ${NO_FALLBACK}`,
        };
  } catch (caught) {
    const e = caught as ExecFileException;
    return {
      ok: false,
      bin,
      version,
      kind: "unsupported",
      error: `${version || bin}: could not read \`codex exec --help\`: ${String(e?.stderr || e?.message || e).slice(0, 300)}. ${NO_FALLBACK}`,
    };
  }
  let auth = "";
  try {
    const st = await run(bin, ["login", "status"]);
    const body = `${st.stdout}\n${st.stderr}`;
    const m = body.match(/logged in using (.+)/i);
    if (!m)
      return {
        ok: false,
        bin,
        version,
        kind: "auth",
        error: `Codex CLI on this worker is not logged in. Run \`codex login\` on the worker machine. ${NO_FALLBACK}`,
      };
    auth = m[1].trim().slice(0, 60);
  } catch (caught) {
    const e = caught as ExecFileException;
    return {
      ok: false,
      bin,
      version,
      kind: "auth",
      error: `Codex CLI on this worker is not logged in (${String(
        e?.stdout || e?.stderr || e?.message || "",
      )
        .trim()
        .split("\n")[0]
        .slice(0, 200)}). Run \`codex login\` on the worker machine. ${NO_FALLBACK}`,
    };
  }
  const models = await modelCatalog(bin);
  const cap: CodexCapability = { ok: true, bin, version, auth, models: models ?? undefined };
  const problem = models ? checkModel(models, model, effort) : null;
  if (problem) return { ...cap, ok: false, kind: "model", error: `${problem} ${NO_FALLBACK}` };
  return cap;
}

interface CatalogModel {
  slug: string;
  supported_reasoning_levels?: unknown;
  default_reasoning_level?: unknown;
}

async function modelCatalog(bin: string): Promise<CodexCapability["models"] | null> {
  try {
    const r = await run(bin, ["debug", "models"], 30_000);
    const d = JSON.parse(r.stdout);
    const list: unknown[] = Array.isArray(d) ? d : Array.isArray(d?.models) ? d.models : [];
    return list
      .filter(
        (m): m is CatalogModel => typeof (m as Partial<CatalogModel> | null)?.slug === "string",
      )
      .map((m) => ({
        slug: m.slug,
        efforts: Array.isArray(m.supported_reasoning_levels)
          ? m.supported_reasoning_levels
              .map((x: unknown) => String((x as { effort?: unknown } | null)?.effort ?? x))
              .filter(Boolean)
          : [],
        default_effort:
          typeof m.default_reasoning_level === "string" ? m.default_reasoning_level : undefined,
      }));
  } catch {
    return null; // catalog unavailable: the CLI reports an unsupported model when the turn starts
  }
}

/** Null when the model (empty = account default) and effort are in the catalog. */
export function checkModel(
  models: NonNullable<CodexCapability["models"]>,
  model: string,
  effort: string,
): string | null {
  if (!models.length) return null;
  const m = model ? models.find((x) => x.slug === model) : null;
  if (model && !m)
    return `Codex model "${model}" is not available to the worker's Codex account (available: ${models.map((x) => x.slug).join(", ")}).`;
  if (effort && m && m.efforts.length && !m.efforts.includes(effort))
    return `Codex model "${model}" does not support reasoning effort "${effort}" (supported: ${m.efforts.join(", ")}).`;
  if (effort && !m && !models.some((x) => x.efforts.includes(effort)))
    return `Reasoning effort "${effort}" is not supported by any Codex model available to this account.`;
  return null;
}
