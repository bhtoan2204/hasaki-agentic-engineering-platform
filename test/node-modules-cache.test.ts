import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeModulesReady, installNodeDependencies, recordDependencies } from "../src/git/provider.ts";
import { TEST_COMMAND } from "../src/workflow/templates.ts";

test("nodeModulesReady rejects package manager markers without a matching worker fingerprint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nm-test-"));
  try {
    await writeFile(join(dir, "package.json"), "{}");
    // No node_modules
    assert.equal(await nodeModulesReady(dir), false);

    const nm = join(dir, "node_modules");
    await mkdir(nm);
    // Empty node_modules
    assert.equal(await nodeModulesReady(dir), false);

    // .platform-ready marker
    await writeFile(join(nm, ".platform-ready"), "");
    assert.equal(await nodeModulesReady(dir), false);
    await rm(join(nm, ".platform-ready"));

    // .package-lock.json marker
    await writeFile(join(nm, ".package-lock.json"), "{}");
    assert.equal(await nodeModulesReady(dir), false);
    await rm(join(nm, ".package-lock.json"));

    // .modules.yaml marker
    await writeFile(join(nm, ".modules.yaml"), "");
    assert.equal(await nodeModulesReady(dir), false);
    await rm(join(nm, ".modules.yaml"));

    // .yarn-integrity marker
    await writeFile(join(nm, ".yarn-integrity"), "");
    assert.equal(await nodeModulesReady(dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installNodeDependencies skips execution when dependencies are already ready", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nm-inst-"));
  try {
    // No package.json
    assert.equal(await installNodeDependencies(dir), false);

    // With package.json and ready node_modules
    await writeFile(join(dir, "package.json"), "{}");
    await mkdir(join(dir, "node_modules"));
    assert.equal(await recordDependencies(dir), true);

    assert.equal(await installNodeDependencies(dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workflow test commands preserve a current dependency fingerprint", async () => {
  const { execFileSync } = await import("node:child_process");
  const { readFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "nm-command-"));
  try {
    await writeFile(join(dir, "package.json"), "{}");
    await mkdir(join(dir, "node_modules"));
    await mkdir(join(dir, "bin"));
    await recordDependencies(dir);
    const version = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
    await writeFile(join(dir, "bin", "npm"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\nprintf '%s\\n' "$*" >> "$CALLS"\n`, { mode: 0o755 });
    execFileSync("bash", ["-c", TEST_COMMAND], { cwd: dir, stdio: "pipe", env: { ...process.env, PLATFORM_NODE_DEPENDENCIES: join(import.meta.dirname, "..", "src", "git", "nodeDependencies.ts"), PATH: `${join(dir, "bin")}:${process.env.PATH}`, CALLS: join(dir, "calls") } });
    assert.equal((await readFile(join(dir, "calls"), "utf8")).trim(), "test --if-present");
    assert.equal(await nodeModulesReady(dir), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("dependency readiness invalidates when the lockfile changes", async () => {
  const { dependencyFingerprint } = await import("../src/git/provider.ts");
  const dir = await mkdtemp(join(tmpdir(), "nm-fingerprint-"));
  try {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "package-lock.json"), "first");
    const first = await dependencyFingerprint(dir);
    await writeFile(join(dir, "package-lock.json"), "second");
    assert.notEqual(await dependencyFingerprint(dir), first);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a failed dependency install cannot leave a reusable worker record", async () => {
  const { readFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "nm-failure-"));
  const previousPath = process.env.PATH;
  try {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "package-lock.json"), "before");
    await mkdir(join(dir, "node_modules"));
    await mkdir(join(dir, "bin"));
    await recordDependencies(dir);
    await writeFile(join(dir, "package-lock.json"), "changed");
    await writeFile(join(dir, "bin", "npm"), "#!/bin/sh\necho 'installation failed' >&2\nexit 1\n", { mode: 0o755 });
    process.env.PATH = `${join(dir, "bin")}:${previousPath}`;
    await assert.rejects(installNodeDependencies(dir), /installation failed/);
    assert.equal(await nodeModulesReady(dir), false);
    await assert.rejects(readFile(join(dir, "node_modules", ".platform-ready")), { code: "ENOENT" });
  } finally {
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test("dependency installation falls back when the inherited cache is not writable", async () => {
  const { installNodeDependencies: install } = await import("../src/git/nodeDependencies.ts");
  const { execFileSync } = await import("node:child_process");
  const { readFile, access } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "nm-cache-fallback-"));
  const previousPath = process.env.PATH;
  const previousCapture = process.env.CACHE_USED;
  try {
    await writeFile(join(dir, "package.json"), "{}");
    await mkdir(join(dir, "node_modules"));
    await mkdir(join(dir, "bin"));
    const cache = join(dir, "unwritable-cache");
    await writeFile(cache, "protected cache path");
    const version = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
    await writeFile(join(dir, "bin", "npm"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\nprintf '%s' "$npm_config_cache" > "$CACHE_USED"\n`, { mode: 0o755 });
    process.env.PATH = `${join(dir, "bin")}:${previousPath}`;
    process.env.CACHE_USED = join(dir, "cache-used");
    assert.equal(await install(dir, cache), true);
    assert.equal(await nodeModulesReady(dir), true);
    assert.equal(await readFile(cache, "utf8"), "protected cache path");
    const used = await readFile(join(dir, "cache-used"), "utf8");
    assert.notEqual(used, cache);
    await assert.rejects(access(used), { code: "ENOENT" }, "temporary cache must be cleaned up");
  } finally {
    process.env.PATH = previousPath;
    if (previousCapture === undefined) delete process.env.CACHE_USED;
    else process.env.CACHE_USED = previousCapture;
    await rm(dir, { recursive: true, force: true });
  }
});
