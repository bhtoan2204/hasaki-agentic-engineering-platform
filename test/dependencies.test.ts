import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dependencyMetrics,
  installNodeDependencies,
  nodeModulesReady,
  recordDependencies,
  resetDependencyMetrics,
  validateDependencies,
  dependencyStats,
  type DependencyOptions,
} from "../src/git/nodeDependencies.ts";

/** Everything here uses temp directories and a fake npm: no network, no database, no real package manager. */
async function fixture(t: { after(fn: () => unknown): void }, manifest: object = { dependencies: { "left-pad": "1.0.0" } }) {
  const dir = await mkdtemp(join(tmpdir(), "deps-"));
  const evidenceDir = join(dir, "..", `evidence-${Math.random().toString(36).slice(2)}`);
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
  const previous = process.env.PATH;
  const install = (version = "10.0.0") => writeFile(join(bin, "npm"), `#!/bin/sh
if [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi
echo "$*" >> "$CALLS"
mkdir -p node_modules/left-pad
printf '{"name":"left-pad","version":"1.0.0"}' > node_modules/left-pad/package.json
printf 'module.exports = 1' > node_modules/left-pad/index.js
`, { mode: 0o755 });
  await install();
  process.env.PATH = `${bin}:${previous}`;
  process.env.CALLS = join(dir, "calls");
  t.after(async () => {
    process.env.PATH = previous;
    delete process.env.CALLS;
    await rm(dir, { recursive: true, force: true });
    await rm(evidenceDir, { recursive: true, force: true });
  });
  const opts: DependencyOptions = { evidenceDir };
  const installs = async () => (await readFile(join(dir, "calls"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  return { dir, bin, evidenceDir, opts, install, installs };
}

test("a marker or any other workspace file never establishes readiness", async (t) => {
  const { dir, opts } = await fixture(t);
  await mkdir(join(dir, "node_modules", "left-pad"), { recursive: true });
  await writeFile(join(dir, "node_modules", "left-pad", "package.json"), '{"version":"1.0.0"}');
  await writeFile(join(dir, "node_modules", ".platform-ready"), "ready");
  await writeFile(join(dir, ".platform-ready"), "ready");
  await writeFile(join(dir, "node_modules", ".package-lock.json"), "{}");
  assert.equal(await nodeModulesReady(dir, opts), false);
  assert.equal(await nodeModulesReady(dir, { ...opts, strict: true }), false);
});

test("an empty or incomplete install is not ready, a complete signed one is", async (t) => {
  const { dir, opts } = await fixture(t);
  await mkdir(join(dir, "node_modules"));
  assert.equal(await recordDependencies(dir, opts), false, "empty node_modules cannot be sealed");
  assert.equal(await nodeModulesReady(dir, opts), false);
  assert.equal(await installNodeDependencies(dir, join(dir, "cache"), opts), true);
  assert.equal(await nodeModulesReady(dir, opts), true);
});

test("modified, deleted, added and corrupted packages are detected", async (t) => {
  const { dir, opts } = await fixture(t);
  await installNodeDependencies(dir, join(dir, "cache"), opts);
  const strict = { ...opts, strict: true };
  const file = join(dir, "node_modules", "left-pad", "index.js");
  assert.equal(await nodeModulesReady(dir, strict), true);
  await writeFile(file, "module.exports = 2"); // same size, different content
  assert.equal(await nodeModulesReady(dir, strict), false, "modified content");
  await installNodeDependencies(dir, join(dir, "cache"), strict);
  assert.equal(await nodeModulesReady(dir, strict), true);
  await writeFile(join(dir, "node_modules", "left-pad", "extra.js"), "x");
  assert.equal(await nodeModulesReady(dir, strict), false, "added file");
  await installNodeDependencies(dir, join(dir, "cache"), strict);
  await rm(file);
  assert.equal(await nodeModulesReady(dir, strict), false, "deleted file");
  await installNodeDependencies(dir, join(dir, "cache"), strict);
  await writeFile(join(dir, "node_modules", "left-pad", "package.json"), "{ not json");
  assert.equal(await nodeModulesReady(dir, strict), false, "corrupted package manifest");
});

test("an unchanged state is validated from metadata without hashing any file", async (t) => {
  const { dir, opts } = await fixture(t);
  await installNodeDependencies(dir, join(dir, "cache"), opts);
  resetDependencyMetrics();
  const result = await validateDependencies(dir, opts);
  assert.deepEqual([result.ready, result.mode], [true, "incremental"]);
  assert.equal(dependencyStats.bytesHashed, 0);
  assert.equal(dependencyStats.filesHashed, 0);
  assert.equal(dependencyStats.incrementalValidations, 1);
  assert.equal(dependencyStats.fullValidations, 0);
  assert.equal(dependencyMetrics().cacheHitRate, 1);
  assert.ok(dependencyStats.filesStatted > 0);
});

test("strict validation always re-hashes, and a metadata-only change is re-proven by content", async (t) => {
  const { dir, opts } = await fixture(t);
  await installNodeDependencies(dir, join(dir, "cache"), opts);
  resetDependencyMetrics();
  assert.equal((await validateDependencies(dir, { ...opts, strict: true })).mode, "full");
  assert.ok(dependencyStats.bytesHashed > 0);
  const when = new Date(Date.now() + 5000);
  await utimes(join(dir, "node_modules", "left-pad", "index.js"), when, when); // metadata differs, content does not
  resetDependencyMetrics();
  const touched = await validateDependencies(dir, opts);
  assert.deepEqual([touched.ready, touched.mode], [true, "full"]);
  assert.equal((await validateDependencies(dir, opts)).mode, "incremental", "evidence refreshed after the content proof");
});

test("an old record is not trusted on metadata alone", async (t) => {
  const { dir, opts } = await fixture(t);
  await installNodeDependencies(dir, join(dir, "cache"), opts);
  const later = { ...opts, now: () => Date.now() + 2 * 60 * 60_000 };
  assert.equal((await validateDependencies(dir, later)).mode, "full");
});

test("manifest, lockfile, node, npm and install config changes invalidate readiness", async (t) => {
  const { dir, opts } = await fixture(t);
  await installNodeDependencies(dir, join(dir, "cache"), opts);
  assert.equal(await nodeModulesReady(dir, opts), true);
  assert.equal(await nodeModulesReady(dir, { ...opts, nodeVersion: "v0.0.1" }), false, "node version");
  // npm --version is cached per PATH for the process lifetime, so a different npm is a different PATH entry.
  const otherBin = join(dir, "bin-other");
  await mkdir(otherBin);
  await writeFile(join(otherBin, "npm"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 99.0.0; exit 0; fi\n", { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${otherBin}:${path}`;
  try { assert.equal(await nodeModulesReady(dir, opts), false, "npm version"); } finally { process.env.PATH = path; }
  assert.equal(await nodeModulesReady(dir, opts), true);
  process.env.npm_config_omit = "dev";
  try { assert.equal(await nodeModulesReady(dir, opts), false, "install config"); } finally { delete process.env.npm_config_omit; }
  await writeFile(join(dir, "package-lock.json"), "{}");
  assert.equal(await nodeModulesReady(dir, opts), false, "lockfile");
  await rm(join(dir, "package-lock.json"));
  assert.equal(await nodeModulesReady(dir, opts), true);
  await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { "left-pad": "1.0.1" } }));
  assert.equal(await nodeModulesReady(dir, opts), false, "manifest");
});

test("missing, corrupted, tampered, wrong-schema and stale evidence is rejected", async (t) => {
  const { dir, opts, evidenceDir } = await fixture(t);
  await installNodeDependencies(dir, join(dir, "cache"), opts);
  const record = join(evidenceDir, (await readdir(evidenceDir)).find((name) => name.endsWith(".json"))!);
  const original = await readFile(record, "utf8");
  const wrapper = JSON.parse(original) as { payload: string; sig: string };
  const attempt = async (text: string) => { await writeFile(record, text); return nodeModulesReady(dir, opts); };
  assert.equal(await attempt("not json"), false, "corrupted");
  assert.equal(await attempt(JSON.stringify({ ...wrapper, payload: wrapper.payload.replace("\"v\":2", "\"v\":1") })), false, "payload changed without the key");
  const forged = { ...JSON.parse(wrapper.payload), digest: "0".repeat(64), checkedAt: Date.now() };
  assert.equal(await attempt(JSON.stringify({ payload: JSON.stringify(forged), sig: wrapper.sig })), false, "bad signature");
  assert.equal(await attempt(JSON.stringify({ payload: wrapper.payload, sig: "zz" })), false, "malformed signature");
  await rm(record);
  assert.equal(await nodeModulesReady(dir, opts), false, "missing");
  await writeFile(record, original);
  assert.equal(await nodeModulesReady(dir, opts), true, "the genuine record still works");
  // A record copied to another workspace is bound to the original and must not vouch for it.
  const other = await mkdtemp(join(tmpdir(), "deps-other-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  await writeFile(join(other, "package.json"), await readFile(join(dir, "package.json")));
  await mkdir(join(other, "node_modules"), { recursive: true });
  assert.equal(await nodeModulesReady(other, opts), false);
});

test("evidence is stored outside the workspace and the agent cannot recreate it", async (t) => {
  const { dir, opts, evidenceDir } = await fixture(t);
  await installNodeDependencies(dir, join(dir, "cache"), opts);
  const names = await readdir(evidenceDir);
  assert.ok(names.some((n) => n.endsWith(".json")) && names.includes(".key"));
  assert.ok(!names.some((n) => n.endsWith(".tmp")), "written atomically, no temp file left");
  assert.ok(!evidenceDir.startsWith(dir));
  assert.equal((await readdir(join(dir, "node_modules"))).includes(".platform-ready"), false);
});

test("a symlinked node_modules is never ready and is never sealed", async (t) => {
  const { dir, opts } = await fixture(t);
  const elsewhere = await mkdtemp(join(tmpdir(), "deps-elsewhere-"));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  await mkdir(join(elsewhere, "left-pad"));
  await writeFile(join(elsewhere, "left-pad", "package.json"), '{"version":"1.0.0"}');
  await symlink(elsewhere, join(dir, "node_modules"));
  assert.equal(await recordDependencies(dir, opts), false);
  assert.equal(await nodeModulesReady(dir, opts), false);
});

test("a failed install leaves no valid evidence", async (t) => {
  const { dir, bin, opts } = await fixture(t);
  await installNodeDependencies(dir, join(dir, "cache"), opts);
  await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { "left-pad": "2.0.0" } }));
  await writeFile(join(bin, "npm"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 10; exit 0; fi\nmkdir -p node_modules\necho boom >&2\nexit 1\n", { mode: 0o755 });
  await assert.rejects(installNodeDependencies(dir, join(dir, "cache"), opts), /boom/);
  assert.equal(await nodeModulesReady(dir, opts), false);
  assert.equal(await nodeModulesReady(dir, { ...opts, strict: true }), false);
});

test("validating a large tree does not block the event loop", async (t) => {
  const { dir, opts } = await fixture(t, {});
  const root = join(dir, "node_modules");
  const packages = 40;
  await Promise.all(Array.from({ length: packages }, async (_, i) => {
    const pkg = join(root, `pkg-${i}`, "lib");
    await mkdir(pkg, { recursive: true });
    await Promise.all(Array.from({ length: 50 }, (_, j) => writeFile(join(pkg, `f${j}.js`), `module.exports = ${i * j}\n`.repeat(20))));
  }));
  assert.equal(await recordDependencies(dir, opts), true);
  let worst = 0, last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 5); last = now; }, 5);
  try {
    assert.equal((await validateDependencies(dir, { ...opts, strict: true })).ready, true);
    assert.equal((await validateDependencies(dir, opts)).ready, true);
  } finally { clearInterval(timer); }
  assert.ok(worst < 250, `event loop stalled for ${Math.round(worst)} ms`);
  assert.ok(dependencyMetrics().eventLoopLagMs !== null);
});

test("the verification helper fails fast, without EROFS noise, when it cannot write worker-owned evidence", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { chmod, mkdtemp: mk } = await import("node:fs/promises");
  const { dir } = await fixture(t);
  // Un-installed workspace; the evidence location is not writable (read-only directory, or a path below a regular file as root).
  const holder = await mk(join(tmpdir(), "ro-evidence-"));
  t.after(async () => { await chmod(holder, 0o755).catch(() => {}); await rm(holder, { recursive: true, force: true }); });
  let evidence = join(holder, "evidence");
  if (process.getuid?.() === 0) { await writeFile(join(holder, "file"), "x"); evidence = join(holder, "file", "evidence"); }
  else { await mkdir(evidence); await chmod(evidence, 0o555); }
  const helper = join(import.meta.dirname, "..", "src", "git", "nodeDependencies.ts");
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", helper, dir], {
    encoding: "utf8", env: { ...process.env, PLATFORM_DEPENDENCY_EVIDENCE_DIR: evidence, CALLS: join(dir, "calls") },
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /worker prepare step must install dependencies/);
  assert.doesNotMatch(run.stderr, /EROFS|EACCES|ENOTDIR|\n\s+at /);
  assert.equal(await readFile(join(dir, "calls"), "utf8").catch(() => ""), "", "no install was attempted");
});

test("the coding-turn and prepare entry point re-hashes in full even when a fresh metadata snapshot exists", async (t) => {
  const { dir } = await fixture(t);
  const { installNodeDependencies: atTrustBoundary, dependencyEvidenceDir } = await import("../src/git/provider.ts");
  const { rm: remove } = await import("node:fs/promises");
  const { realpath } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  assert.equal(await atTrustBoundary(dir), true, "first call installs");
  resetDependencyMetrics();
  assert.equal(await atTrustBoundary(dir), false, "nothing to install the second time");
  assert.ok(dependencyStats.bytesHashed > 0, "a full re-hash decided readiness, not the metadata fast path");
  assert.equal(dependencyStats.fullValidations >= 1, true);
  // The same state through the default (non-strict) check would have been an incremental hit that hashes nothing.
  resetDependencyMetrics();
  assert.equal(await nodeModulesReady(dir, { evidenceDir: dependencyEvidenceDir() }), true);
  assert.equal(dependencyStats.bytesHashed, 0);
  await remove(join(dependencyEvidenceDir(), `${createHash("sha256").update(await realpath(dir)).digest("hex")}.json`), { force: true });
});

test("agents cannot write the worker-owned dependency evidence directory", async () => {
  const { protectedRootsFor } = await import("../src/platform/selfDevelopment.ts");
  const { decide, decideBash } = await import("../src/agent/toolPolicy.ts");
  const { dependencyEvidenceDir } = await import("../src/git/provider.ts");
  const evidence = dependencyEvidenceDir();
  const ctx = { mode: "coding" as const, workspaces: ["/data/worktrees/T1/app"], baseBranch: "main", protectedRoots: protectedRootsFor([]) };
  assert.ok(ctx.protectedRoots.includes(evidence));
  assert.equal(decide("Write", { file_path: join(evidence, "forged.json"), content: "{}" }, ctx).allow, false);
  assert.equal(decide("Edit", { file_path: join(evidence, ".key"), old_string: "a", new_string: "b" }, ctx).allow, false);
  assert.equal(decideBash(`printf '{}' > ${join(evidence, "forged.json")}`, ctx, "/data/worktrees/T1/app").allow, false);
  assert.equal(decideBash(`rm -f ${join(evidence, "x.json")}`, ctx, "/data/worktrees/T1/app").allow, false);
});

test("commands do not inherit the evidence directory; only the dependency helper receives it", async (t) => {
  const { runVerificationCommand } = await import("../src/workflow/executors/builtin.ts");
  const { dir } = await fixture(t);
  const result = await runVerificationCommand(`node -e 'console.log("evidence=" + (process.env.PLATFORM_DEPENDENCY_EVIDENCE_DIR ?? "unset"))'; env | grep -c PLATFORM_DEPENDENCY_EVIDENCE_DIR || true`, dir, {}, 30000, new AbortController().signal);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /evidence=unset/);
  assert.match(result.output, /\n0\n?$/);
});
