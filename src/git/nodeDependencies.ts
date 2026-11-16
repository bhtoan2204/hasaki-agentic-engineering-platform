import { homedir, tmpdir } from "node:os";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, createReadStream, lstatSync, readdirSync } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const exec = promisify(execFile);

/**
 * Worker-owned dependency readiness.
 *
 * Readiness is established ONLY by a signed evidence record kept in a worker directory outside the workspace
 * (the agent can write the workspace, so nothing inside it, such as `.platform-ready`, is ever trusted).
 * The record binds the workspace identity, manifests, lockfile, Node/npm versions, install configuration and a
 * content digest of node_modules. All filesystem work is asynchronous with bounded concurrency.
 *
 * Validation tiers:
 *  - incremental (default): signed record + lstat-only metadata walk (path, mode, size, mtime/ctime ns, inode) must match
 *    the signed snapshot and the record must be recent. No file content is read.
 *  - full (strict, or any metadata difference, or an old record): every file is re-hashed against the signed digest.
 *    Strict is used at trust boundaries (the verification helper).
 * A metadata fast path alone is not tamper-proof against an attacker who restores size/mtime/ctime/inode, which is why
 * strict mode exists and the incremental result expires.
 */
export const EVIDENCE_SCHEMA = 2;
const FAST_PATH_MAX_AGE_MS = 60 * 60_000;
const LOCK_STALE_MS = 15 * 60_000;
const FS_CONCURRENCY = 16;

export interface DependencyOptions {
  /** Where signed evidence lives. Default: PLATFORM_DEPENDENCY_EVIDENCE_DIR, else ~/.claude-task-platform/dependency-evidence. */
  evidenceDir?: string;
  /** Always re-hash every installed file (trust boundary). */
  strict?: boolean;
  /** Test seams. */
  now?: () => number;
  nodeVersion?: string;
}

export const dependencyStats = {
  validations: 0,
  hits: 0,
  misses: 0,
  fullValidations: 0,
  incrementalValidations: 0,
  validationMs: 0,
  installs: 0,
  installMs: 0,
  duplicatesAvoided: 0,
  filesStatted: 0,
  filesRead: 0,
  filesHashed: 0,
  bytesHashed: 0,
};
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
let loopDelayStarted = false;

/** In-process counters plus event loop lag, for the metrics route and log lines. */
export function dependencyMetrics() {
  const total = dependencyStats.hits + dependencyStats.misses;
  const ms = (ns: number) => (Number.isFinite(ns) ? Math.round(ns / 1e4) / 100 : 0);
  return {
    ...dependencyStats,
    cacheHitRate: total ? dependencyStats.hits / total : null,
    avgValidationMs: dependencyStats.validations ? dependencyStats.validationMs / dependencyStats.validations : 0,
    avgInstallMs: dependencyStats.installs ? dependencyStats.installMs / dependencyStats.installs : 0,
    eventLoopLagMs: loopDelayStarted ? { p50: ms(loopDelay.percentile(50)), p99: ms(loopDelay.percentile(99)), max: ms(loopDelay.max) } : null,
  };
}
export function resetDependencyMetrics() {
  for (const key of Object.keys(dependencyStats) as (keyof typeof dependencyStats)[]) dependencyStats[key] = 0;
  loopDelay.reset();
}
function startLoopMonitor() {
  if (loopDelayStarted) return;
  loopDelay.enable();
  loopDelayStarted = true;
}

function evidenceDirectory(opts: DependencyOptions) {
  return resolve(opts.evidenceDir ?? process.env.PLATFORM_DEPENDENCY_EVIDENCE_DIR ?? join(homedir(), ".claude-task-platform", "dependency-evidence"));
}

class Gate {
  active = 0;
  waiting: (() => void)[] = [];
  limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((done) => this.waiting.push(done));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

const npmVersions = new Map<string, Promise<string>>();
/** npm --version is a process spawn: cache it per PATH so repeated checks stay cheap. */
function npmVersion() {
  const key = process.env.PATH ?? "";
  let version = npmVersions.get(key);
  if (!version) {
    version = exec("npm", ["--version"], { timeout: 5000, encoding: "utf8" }).then((r) => r.stdout.trim());
    version.catch(() => npmVersions.delete(key));
    npmVersions.set(key, version);
  }
  return version;
}

/** Digest of everything that decides which dependencies would be installed. Null: never ready (credentials in the repo). */
export async function dependencyFingerprint(workspace: string, opts: DependencyOptions = {}): Promise<string | null> {
  try {
    const FILES = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", ".nvmrc", ".node-version"];
    // These may contain credentials. Do not read them or guess their effect on installation.
    const credentialed = [".npmrc", ".yarnrc.yml"];
    const [version, contents, risky] = await Promise.all([
      npmVersion(),
      Promise.all(FILES.map((file) => readFile(join(workspace, file)).catch(() => null))),
      Promise.all(credentialed.map((file) => access(join(workspace, file)).then(() => true, () => false))),
    ]);
    if (contents[0] === null || risky.some(Boolean)) return null;
    const hash = createHash("sha256").update(JSON.stringify({ node: opts.nodeVersion ?? process.version, npm: version,
      platform: process.platform, arch: process.arch, ignoreScripts: true,
      nodeEnv: process.env.NODE_ENV ?? "", omit: process.env.npm_config_omit ?? "",
      include: process.env.npm_config_include ?? "", legacyPeerDeps: process.env.npm_config_legacy_peer_deps ?? "",
      registry: process.env.npm_config_registry ?? "" }));
    FILES.forEach((file, i) => hash.update(file).update("\0").update(contents[i] ?? "absent").update("\0"));
    return hash.digest("hex");
  } catch { return null; }
}

interface Entry { rel: string; path: string; kind: "f" | "d" | "l"; mode: bigint; size: bigint; mtime: bigint; ctime: bigint; ino: bigint }

const SLICE_MS = 4;
const yieldLoop = () => new Promise<void>((done) => setImmediate(done));

/**
 * lstat-only walk, cooperatively time-sliced: synchronous syscalls (several times cheaper per file than a promise per
 * stat) run for at most SLICE_MS, then the loop gets control back via setImmediate. No single traversal step blocks the
 * event loop for more than a few milliseconds, whatever the tree size. A missing directory is an empty tree.
 */
async function walkTree(root: string): Promise<Entry[]> {
  const out: Entry[] = [];
  const pending: [string, string][] = [[root, ""]];
  let sliceStart = performance.now();
  try {
    while (pending.length) {
      const [dir, prefix] = pending.pop()!;
      let names: string[];
      try { names = readdirSync(dir); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT" && dir === root) return out;
        throw e;
      }
      for (const name of names) {
        const path = join(dir, name), rel = `${prefix}/${name}`;
        const st = lstatSync(path, { bigint: true });
        dependencyStats.filesStatted++;
        const kind = st.isSymbolicLink() ? "l" : st.isDirectory() ? "d" : st.isFile() ? "f" : null;
        if (!kind) throw new Error("Unsupported dependency entry");
        out.push({ rel, path, kind, mode: st.mode, size: st.size, mtime: st.mtimeNs, ctime: st.ctimeNs, ino: st.ino });
        if (kind === "d") pending.push([path, rel]);
      }
      if (performance.now() - sliceStart > SLICE_MS) { await yieldLoop(); sliceStart = performance.now(); }
    }
  } finally { /* nothing to release */ }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function snapshotDigest(entries: Entry[]) {
  const hash = createHash("sha256");
  for (const e of entries) hash.update(`${e.rel}|${e.kind}|${e.mode}|${e.size}|${e.mtime}|${e.ctime}|${e.ino}\n`);
  return hash.digest("hex");
}

async function hashFile(path: string, gate: Gate) {
  return gate.run(async () => {
    const hash = createHash("sha256");
    dependencyStats.filesRead++;
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk as Buffer);
      dependencyStats.bytesHashed += (chunk as Buffer).length;
    }
    dependencyStats.filesHashed++;
    return hash.digest("hex");
  });
}

/** Content digest of the installed tree, including package code and links. Symlinks must stay inside the workspace. */
async function contentDigest(workspace: string, entries: Entry[], gate: Gate) {
  const realWorkspace = await realpath(workspace);
  const parts = await Promise.all(entries.map(async (e) => {
    const head = `${e.rel}|${e.kind}|${e.mode}|${e.size}`;
    if (e.kind === "d") return head;
    if (e.kind === "f") return `${head}|${await hashFile(e.path, gate)}`;
    const target = await realpath(e.path);
    if (relative(realWorkspace, target).startsWith("..")) throw new Error("Dependency link leaves repository");
    const targetStat = await stat(target);
    return `${head}|${await gate.run(() => readlink(e.path))}|${targetStat.isFile() ? await hashFile(target, gate) : "-"}`;
  }));
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

async function hasDependencies(workspace: string) {
  const manifest = JSON.parse(await readFile(join(workspace, "package.json"), "utf8"));
  return ["dependencies", "devDependencies", "optionalDependencies"].some((key) => Object.keys(manifest[key] ?? {}).length);
}

/** Every declared and locked package must be present at the locked version. An empty or partial install fails. */
async function completeInstall(workspace: string) {
  try {
    const manifest = JSON.parse(await readFile(join(workspace, "package.json"), "utf8"));
    const lock = await readFile(join(workspace, "package-lock.json"), "utf8").then((text) => JSON.parse(text), () => null);
    const omit = new Set((process.env.npm_config_omit ?? (process.env.NODE_ENV === "production" ? "dev" : "")).split(/[,\s]+/));
    const required = { ...manifest.dependencies, ...(!omit.has("dev") ? manifest.devDependencies : {}) };
    const installedVersion = async (dir: string) => JSON.parse(await readFile(join(workspace, dir, "package.json"), "utf8")).version as string | undefined;
    for (const name of Object.keys(required)) {
      if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) return false;
      const installed = await installedVersion(join("node_modules", name));
      const locked = lock?.packages?.[`node_modules/${name}`];
      if (!installed || (locked?.version && installed !== locked.version)) return false;
    }
    for (const [path, raw] of Object.entries(lock?.packages ?? {})) {
      const entry = raw as { optional?: boolean; dev?: boolean; link?: boolean; version?: string };
      if (!path || entry.optional || (entry.dev && omit.has("dev")) || entry.link) continue;
      if (!path.startsWith("node_modules/") || path.split("/").includes("..")) return false;
      if (entry.version && (await installedVersion(path)) !== entry.version) return false;
    }
    return true;
  } catch { return false; }
}

interface Evidence {
  v: number; workspace: string; dev: string; ino: string; fingerprint: string;
  digest: string; snapshot: string; files: number; checkedAt: number;
}

const keyCache = new Map<string, string>();
async function signingKey(dir: string) {
  const cached = keyCache.get(dir);
  if (cached) return cached;
  const file = join(dir, ".key");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const key = await readFile(file, "utf8");
  if (key.length >= 32) keyCache.set(dir, key);
  return key;
}
const sign = (key: string, payload: string) => createHmac("sha256", key).update(payload).digest("hex");
const evidenceFile = (dir: string, realWorkspace: string) => join(dir, `${createHash("sha256").update(realWorkspace).digest("hex")}.json`);

async function identity(workspace: string) {
  const real = await realpath(workspace);
  const st = await stat(real, { bigint: true });
  return { real, dev: String(st.dev), ino: String(st.ino) };
}

/** Reads and authenticates the record. Anything missing, corrupted, wrong-schema or tampered is null. */
async function readEvidence(dir: string, real: string): Promise<Evidence | null> {
  try {
    const wrapper = JSON.parse(await readFile(evidenceFile(dir, real), "utf8")) as { payload?: unknown; sig?: unknown };
    if (typeof wrapper.payload !== "string" || typeof wrapper.sig !== "string") return null;
    const expected = Buffer.from(sign(await signingKey(dir), wrapper.payload), "hex");
    const given = Buffer.from(wrapper.sig, "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const evidence = JSON.parse(wrapper.payload) as Evidence;
    return evidence.v === EVIDENCE_SCHEMA && evidence.workspace === real ? evidence : null;
  } catch { return null; }
}

/** Atomic: temp file in the same directory, fsync, rename. */
async function writeEvidence(dir: string, evidence: Evidence) {
  const key = await signingKey(dir);
  const payload = JSON.stringify(evidence);
  const file = evidenceFile(dir, evidence.workspace), tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ payload, sig: sign(key, payload) }));
    await handle.sync();
  } finally { await handle.close(); }
  await rename(tmp, file);
}

async function nodeModulesIsDirectory(workspace: string, emptyIsFine: boolean) {
  const st = await lstat(join(workspace, "node_modules")).catch(() => null);
  if (!st) return emptyIsFine;
  return st.isDirectory(); // a symlinked node_modules could write through to another checkout
}

export interface Validation { ready: boolean; mode: "incremental" | "full" | "none"; reason?: string }

/** Is the installed state exactly the one the worker installed and signed? */
export async function validateDependencies(workspace: string, opts: DependencyOptions = {}): Promise<Validation> {
  startLoopMonitor();
  const began = performance.now();
  try {
    const result = await validate(workspace, opts);
    dependencyStats.validations++;
    if (result.ready) dependencyStats.hits++; else dependencyStats.misses++;
    if (result.mode === "full") dependencyStats.fullValidations++;
    if (result.mode === "incremental") dependencyStats.incrementalValidations++;
    return result;
  } finally { dependencyStats.validationMs += performance.now() - began; }
}

async function validate(workspace: string, opts: DependencyOptions): Promise<Validation> {
  const no = (reason: string, mode: Validation["mode"] = "none"): Validation => ({ ready: false, mode, reason });
  const fingerprint = await dependencyFingerprint(workspace, opts);
  if (!fingerprint) return no("no fingerprint");
  const deps = await hasDependencies(workspace).catch(() => null);
  if (deps === null) return no("unreadable manifest");
  if (!(await nodeModulesIsDirectory(workspace, !deps))) return no("node_modules is missing or a link");
  const id = await identity(workspace);
  const dir = evidenceDirectory(opts);
  const evidence = await readEvidence(dir, id.real);
  if (!evidence) return no("no valid evidence");
  if (evidence.fingerprint !== fingerprint || evidence.dev !== id.dev || evidence.ino !== id.ino) return no("evidence is stale");
  const now = (opts.now ?? Date.now)();
  const gate = new Gate(FS_CONCURRENCY);
  let entries: Entry[];
  try { entries = await walkTree(join(workspace, "node_modules")); } catch { return no("unreadable installed tree"); }
  if (!opts.strict && now - evidence.checkedAt < FAST_PATH_MAX_AGE_MS && snapshotDigest(entries) === evidence.snapshot) return { ready: true, mode: "incremental" };
  // Full verification: the signed content digest is the authority; metadata only decides how often we pay for it.
  let digest: string;
  try { digest = await contentDigest(workspace, entries, gate); } catch { return no("unreadable installed tree", "full"); }
  if (digest !== evidence.digest) return no("installed content differs from signed evidence", "full");
  if (deps && !(await completeInstall(workspace))) return no("incomplete install", "full");
  // Contents are proven identical: refresh metadata so later checks take the fast path again.
  await writeEvidence(dir, { ...evidence, snapshot: snapshotDigest(entries), files: entries.length, checkedAt: now }).catch(() => {});
  return { ready: true, mode: "full" };
}

/** Compatibility name: true only for a signed, current installation (incremental unless `strict`). */
export async function nodeModulesReady(workspace: string, opts: DependencyOptions = {}) {
  return (await validateDependencies(workspace, opts)).ready;
}

/** Sign the current installed state. Only called by the worker after a successful, complete install. */
export async function recordDependencies(workspace: string, opts: DependencyOptions = {}) {
  const fingerprint = await dependencyFingerprint(workspace, opts);
  if (!fingerprint) return false;
  const deps = await hasDependencies(workspace);
  if (!(await nodeModulesIsDirectory(workspace, !deps))) return false;
  if (deps && !(await completeInstall(workspace))) return false;
  const id = await identity(workspace);
  const gate = new Gate(FS_CONCURRENCY);
  const entries = await walkTree(join(workspace, "node_modules"));
  const digest = await contentDigest(workspace, entries, gate);
  await writeEvidence(evidenceDirectory(opts), { v: EVIDENCE_SCHEMA, workspace: id.real, dev: id.dev, ino: id.ino, fingerprint,
    digest, snapshot: snapshotDigest(entries), files: entries.length, checkedAt: (opts.now ?? Date.now)() });
  return true;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Cross-process mutual exclusion per workspace: mkdir is atomic. A dead owner or an old lock is taken over. */
async function withInstallLock<T>(dir: string, real: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(dir, "locks", createHash("sha256").update(real).digest("hex"));
  await mkdir(join(dir, "locks"), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_STALE_MS;
  for (;;) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, "owner"), JSON.stringify({ pid: process.pid, at: Date.now() }));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const owner = await readFile(join(lock, "owner"), "utf8").then((text) => JSON.parse(text) as { pid: number; at: number }, () => null);
      const born = owner ? owner.at : ((await stat(lock).catch(() => null))?.mtimeMs ?? 0);
      if (Date.now() - born > (owner ? LOCK_STALE_MS : 30_000) || (owner && !alive(owner.pid))) { await rm(lock, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error("Timed out waiting for another dependency installation");
      await sleep(50);
    }
  }
  try { return await fn(); } finally { await rm(lock, { recursive: true, force: true }); }
}

const flights = new Map<string, Promise<boolean>>();

/**
 * A git worktree does not contain node_modules. The coding sandbox has no network, so the worker installs here.
 * Lifecycle scripts are not run: this executes for whatever repository the run was allowed to prepare.
 * Returns true when it actually installed. Concurrent callers for one workspace share one flight (and one install).
 */
export async function installNodeDependencies(workspace: string, cache?: string, opts: DependencyOptions = {}): Promise<boolean> {
  if (!(await access(join(workspace, "package.json")).then(() => true, () => false))) return false;
  const real = await realpath(workspace);
  const key = `${real}\0${opts.strict ? "strict" : "fast"}`;
  const running = flights.get(key);
  if (running) {
    dependencyStats.duplicatesAvoided++;
    await running;
    return false;
  }
  const flight = ensure(workspace, real, cache, opts);
  flights.set(key, flight);
  try { return await flight; } finally { flights.delete(key); }
}

async function ensure(workspace: string, real: string, cache: string | undefined, opts: DependencyOptions) {
  if ((await validateDependencies(workspace, opts)).ready) return false;
  return withInstallLock(evidenceDirectory(opts), real, async () => {
    // Another caller or process may have finished while we waited for the lock.
    if ((await validateDependencies(workspace, opts)).ready) return false;
    const began = performance.now();
    try { await install(workspace, real, cache, opts); } finally {
      dependencyStats.installs++;
      dependencyStats.installMs += performance.now() - began;
    }
    return true;
  });
}

async function install(workspace: string, real: string, cache: string | undefined, opts: DependencyOptions) {
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
    // Nothing may vouch for a state that is being replaced: drop the evidence (and any legacy in-workspace marker) first.
    await rm(evidenceFile(evidenceDirectory(opts), real), { force: true });
    await rm(join(workspace, "node_modules", ".platform-ready"), { force: true });
    const before = await dependencyFingerprint(workspace, opts);
    const ci = await access(join(workspace, "package-lock.json")).then(() => true, () => false);
    const runOpts = {
      cwd: workspace,
      timeout: 10 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, npm_config_cache: npmCache },
    };
    const flags = ["--ignore-scripts", "--no-audit", "--no-fund"];
    try {
      await exec("npm", [ci ? "ci" : "install", ...(!ci ? ["--no-package-lock"] : []), ...flags], runOpts);
    } catch (e) {
      // The repository's own lock file is out of sync with package.json (npm ci EUSAGE): install from package.json
      // without reading or rewriting the lock, so the worktree stays clean.
      if (!ci || !/EUSAGE|in sync/.test(String((e as { stderr?: unknown }).stderr ?? (e as Error).message))) throw e;
      await exec("npm", ["install", "--no-package-lock", ...flags], runOpts);
    }
    // Evidence only for the exact state that was requested, and only after a complete installation.
    if (before && before === (await dependencyFingerprint(workspace, opts))) await recordDependencies(workspace, opts);
  } finally {
    if (temporaryCache) await rm(temporaryCache, { recursive: true, force: true });
  }
}

/** Verification entry point: `node nodeDependencies.ts <workspace>` re-verifies strictly, installing when needed. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = process.argv[2] ?? process.cwd();
  await installNodeDependencies(workspace, process.env.npm_config_cache, { strict: true });
  if (process.env.PLATFORM_DEPENDENCY_METRICS === "1") console.log(`dependencies: ${JSON.stringify(dependencyMetrics())}`);
}
