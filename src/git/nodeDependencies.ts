import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const exec = promisify(execFile);

let npmVersion: string | undefined;
/** The worker owns this record; package-manager metadata is never manufactured. */
export function dependencyFingerprint(workspace: string): string | null {
  try {
    if (!existsSync(join(workspace, "package.json"))) return null;
    // These may contain credentials. Do not read them or guess their effect on installation.
    if ([".npmrc", ".yarnrc.yml"].some(file => existsSync(join(workspace, file)))) return null;
    npmVersion ??= execFileSync("npm", ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
    const hash = createHash("sha256").update(JSON.stringify({ node: process.version, npm: npmVersion,
      platform: process.platform, arch: process.arch, ignoreScripts: true,
      nodeEnv: process.env.NODE_ENV ?? "", omit: process.env.npm_config_omit ?? "",
      include: process.env.npm_config_include ?? "", legacyPeerDeps: process.env.npm_config_legacy_peer_deps ?? "" }));
    for (const file of ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", ".nvmrc", ".node-version"])
      hash.update(file).update("\0").update(existsSync(join(workspace, file)) ? readFileSync(join(workspace, file)) : "absent").update("\0");
    return hash.digest("hex");
  } catch { return null; }
}

/** Only a successful worker installation for the current dependency/runtime state establishes readiness. */
export function nodeModulesReady(workspace: string) {
  const fingerprint = dependencyFingerprint(workspace);
  if (!fingerprint) return false;
  try { return readFileSync(join(workspace, "node_modules", ".platform-ready"), "utf8") === fingerprint; }
  catch { return false; }
}

/**
 * A git worktree does not contain node_modules. The coding sandbox has no network, so the worker installs here.
 * Lifecycle scripts are not run: this executes for whatever repository the run was allowed to prepare.
 * Returns true when it actually installed.
 */
export async function installNodeDependencies(workspace: string, cache?: string): Promise<boolean> {
  if (!existsSync(join(workspace, "package.json")) || nodeModulesReady(workspace)) return false;
  if (cache) await mkdir(cache, { recursive: true });
  const expected = dependencyFingerprint(workspace);
  await rm(join(workspace, "node_modules", ".platform-ready"), { force: true });
  const ci = existsSync(join(workspace, "package-lock.json"));
  const opts = {
    cwd: workspace,
    timeout: 10 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ...(cache ? { npm_config_cache: cache } : {}) },
  };
  const flags = ["--ignore-scripts", "--no-audit", "--no-fund"];
  try {
    await exec("npm", [ci ? "ci" : "install", ...(!ci ? ["--no-package-lock"] : []), ...flags], opts);
  } catch (e) {
    // The repository's own lock file is out of sync with package.json (npm ci EUSAGE): install from package.json
    // without reading or rewriting the lock, so the worktree stays clean.
    if (!ci || !/EUSAGE|in sync/.test(String((e as { stderr?: unknown }).stderr ?? (e as Error).message))) throw e;
    await exec("npm", ["install", "--no-package-lock", ...flags], opts);
  }
  const fingerprint = dependencyFingerprint(workspace);
  if (fingerprint && fingerprint === expected && existsSync(join(workspace, "node_modules")))
    await writeFile(join(workspace, "node_modules", ".platform-ready"), fingerprint);
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await installNodeDependencies(process.argv[2] ?? process.cwd(), process.env.npm_config_cache);
}
