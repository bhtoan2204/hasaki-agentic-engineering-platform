import { execFile, type ExecFileException } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../../../config.ts";
import { agentEnvironment } from "../../environment.ts";

const exec = promisify(execFile);

export interface CursorCapability {
  supportsModel?: boolean;
  ok: boolean;
  bin: string;
  error?: string;
}

let capabilityCache: CursorCapability | null = null;

export function cursorBinary(): string {
  return config.agent.cursorBin || "agent";
}

export function cursorEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return agentEnvironment(env, "cursor");
}

/** Probe the installed CLI. Cached for the process. Never falls back to Claude. */
export async function cursorCapabilities(force = false): Promise<CursorCapability> {
  if (capabilityCache && !force && !config.agent.cursorBin) return capabilityCache;
  const bin = cursorBinary();
  let help = "";
  try {
    const out = await exec(bin, ["--help"], {
      env: cursorEnv(process.env),
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    help = `${out.stdout}\n${out.stderr}`;
  } catch (caught) {
    const e = caught as ExecFileException;
    const missing = e?.code === "ENOENT";
    return finish({
      ok: false,
      bin,
      error: missing
        ? `Cursor CLI was not found (${bin}). Install it and ensure \`agent\` is on PATH, then run \`agent login\`. The platform will not fall back to Claude.`
        : `Cursor CLI (${bin}) failed: ${String(e?.stderr || e?.message || e).slice(0, 400)}. The platform will not fall back to Claude.`,
    });
  }
  for (const flag of [
    "--print",
    "--output-format",
    "--resume",
    "--mode",
    "--approve-mcps",
    "--trust",
    "--sandbox",
    "--force",
  ]) {
    if (!help.includes(flag))
      return finish({
        ok: false,
        bin,
        error: `Cursor CLI at ${bin} does not advertise ${flag}. This version cannot enforce the platform's execution policy. The platform will not fall back to Claude.`,
      });
  }
  if (!config.agentEnv.cursorApiKey) {
    try {
      const st = await exec(bin, ["status"], {
        env: cursorEnv(process.env),
        timeout: 20_000,
        maxBuffer: 256 * 1024,
      });
      const body = `${st.stdout}\n${st.stderr}`;
      if (!/logged in/i.test(body))
        return finish({
          ok: false,
          bin,
          error:
            "Cursor CLI is not authenticated. Run `agent login` on this machine, or set CURSOR_API_KEY. The platform will not fall back to Claude.",
        });
    } catch (caught) {
      const e = caught as ExecFileException;
      return finish({
        ok: false,
        bin,
        error: `Cursor CLI authentication check failed: ${String(e?.stderr || e?.message || e).split("\n")[0]}. Run \`agent login\` or set CURSOR_API_KEY. The platform will not fall back to Claude.`,
      });
    }
  }
  return finish({ ok: true, bin, supportsModel: help.includes("--model") });
}

function finish(c: CursorCapability): CursorCapability {
  if (!config.agent.cursorBin) capabilityCache = c;
  return c;
}
