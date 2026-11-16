import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { constants, existsSync, readFileSync, readdirSync, lstatSync, realpathSync, readlinkSync } from "node:fs";
import { access, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
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

/** Installed contents must still match the successful install, including package code and links. */
function installedFingerprint(workspace: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string, prefix = "") => {
    for (const name of readdirSync(dir).sort()) {
      if (!prefix && name === ".platform-ready") continue;
      const path = join(dir, name), key = `${prefix}/${name}`, st = lstatSync(path);
      hash.update(key).update(String(st.mode));
      if (st.isSymbolicLink()) {
        const target = realpathSync(path);
        if (relative(realpathSync(workspace), target).startsWith("..")) throw new Error("Dependency link leaves repository");
        hash.update(readlinkSync(path));
        if (lstatSync(target).isFile()) hash.update(readFileSync(target));
      }
      else if (st.isDirectory()) walk(path, key);
      else if (st.isFile()) hash.update(readFileSync(path));
      else throw new Error("Unsupported dependency entry");
    }
  };
  walk(join(workspace, "node_modules"));
  return hash.digest("hex");
}
function completeInstall(workspace: string) {
  const manifest = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"));
  const lock = existsSync(join(workspace, "package-lock.json")) ? JSON.parse(readFileSync(join(workspace, "package-lock.json"), "utf8")) : null;
  const omit = new Set((process.env.npm_config_omit ?? (process.env.NODE_ENV === "production" ? "dev" : "")).split(/[,\s]+/));
  const required = { ...manifest.dependencies, ...(!omit.has("dev") ? manifest.devDependencies : {}) };
  for (const name of Object.keys(required)) {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) return false;
    const installed = JSON.parse(readFileSync(join(workspace, "node_modules", name, "package.json"), "utf8"));
    const locked = lock?.packages?.[`node_modules/${name}`];
    if (!installed.version || (locked?.version && installed.version !== locked.version)) return false;
  }
  for (const [path, raw] of Object.entries(lock?.packages ?? {})) {
    const entry = raw as { optional?: boolean; dev?: boolean; link?: boolean; version?: string };
    if (!path || entry.optional || (entry.dev && omit.has("dev")) || entry.link) continue;
    if (!path.startsWith("node_modules/") || path.split("/").includes("..")) return false;
    const installed = JSON.parse(readFileSync(join(workspace, path, "package.json"), "utf8"));
    if (entry.version && installed.version !== entry.version) return false;
  }
  return true;
}
function hasDependencies(workspace: string) {
  const manifest = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"));
  return ["dependencies", "devDependencies", "optionalDependencies"].some(key => Object.keys(manifest[key] ?? {}).length);
}
/** Only a successful worker installation for the current dependency/runtime state establishes readiness. */
export function nodeModulesReady(workspace: string) {
  const fingerprint = dependencyFingerprint(workspace);
  if (!fingerprint) return false;
  try {
    const record = readFileSync(join(workspace, "node_modules", ".platform-ready"), "utf8");
    // Empty dependency manifests need no package evidence; retain compatibility with earlier empty installs.
    if (!hasDependencies(workspace) && record === fingerprint) return true;
    const evidence = JSON.parse(record);
    return evidence.dependencies === fingerprint && completeInstall(workspace) && evidence.installed === installedFingerprint(workspace);
  }
  catch { return false; }
}

/**
 * A git worktree does not contain node_modules. The coding sandbox has no network, so the worker installs here.
 * Lifecycle scripts are not run: this executes for whatever repository the run was allowed to prepare.
 * Returns true when it actually installed.
 */
export async function installNodeDependencies(workspace: string, cache?: string): Promise<boolean> {
  if (!existsSync(join(workspace, "package.json")) || nodeModulesReady(workspace)) return false;
  let npmCache = cache || process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE || join(homedir(), ".npm");
  let temporaryCache: string | null = null;
  try {
    await mkdir(npmCache, { recursive: true });
    await access(npmCache, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    // The outer npm process may point at a HOME/cache mounted read-only by verification isolation.
    // Keep that boundary intact and use private writable scratch space for this installation only.
    temporaryCache = await mkdtemp(join(tmpdir(), "ctp-npm-cache-"));
    npmCache = temporaryCache;
  }
  try {
    const expected = dependencyFingerprint(workspace);
    await rm(join(workspace, "node_modules", ".platform-ready"), { force: true });
    const ci = existsSync(join(workspace, "package-lock.json"));
    const opts = {
      cwd: workspace,
      timeout: 10 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, npm_config_cache: npmCache },
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
    if (fingerprint && fingerprint === expected && existsSync(join(workspace, "node_modules")) && (!hasDependencies(workspace) || completeInstall(workspace)))
      await writeFile(join(workspace, "node_modules", ".platform-ready"), hasDependencies(workspace)
        ? JSON.stringify({ dependencies: fingerprint, installed: installedFingerprint(workspace) }) : fingerprint);
    return true;
  } finally {
    if (temporaryCache) await rm(temporaryCache, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await installNodeDependencies(process.argv[2] ?? process.cwd(), process.env.npm_config_cache);
}
