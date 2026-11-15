import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dependencyFingerprint, nodeModulesReady, installNodeDependencies } from "../src/git/provider.ts";
import { TEST_COMMAND } from "../src/workflow/templates.ts";

test("nodeModulesReady rejects package manager markers without a matching worker fingerprint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nm-test-"));
  try {
    // No node_modules
    assert.equal(nodeModulesReady(dir), false);

    const nm = join(dir, "node_modules");
    await mkdir(nm);
    // Empty node_modules
    assert.equal(nodeModulesReady(dir), false);

    // .platform-ready marker
    await writeFile(join(nm, ".platform-ready"), "");
    assert.equal(nodeModulesReady(dir), false);
    await rm(join(nm, ".platform-ready"));

    // .package-lock.json marker
    await writeFile(join(nm, ".package-lock.json"), "{}");
    assert.equal(nodeModulesReady(dir), false);
    await rm(join(nm, ".package-lock.json"));

    // .modules.yaml marker
    await writeFile(join(nm, ".modules.yaml"), "");
    assert.equal(nodeModulesReady(dir), false);
    await rm(join(nm, ".modules.yaml"));

    // .yarn-integrity marker
    await writeFile(join(nm, ".yarn-integrity"), "");
    assert.equal(nodeModulesReady(dir), false);
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
    const nm = join(dir, "node_modules");
    await mkdir(nm);
    await writeFile(join(nm, ".platform-ready"), dependencyFingerprint(dir)!);

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
    await writeFile(join(dir, "node_modules", ".platform-ready"), dependencyFingerprint(dir)!);
    const version = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
    await writeFile(join(dir, "bin", "npm"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\nprintf '%s\\n' "$*" >> "$CALLS"\n`, { mode: 0o755 });
    execFileSync("bash", ["-c", TEST_COMMAND], { cwd: dir, stdio: "pipe", env: { ...process.env, PLATFORM_NODE_DEPENDENCIES: join(import.meta.dirname, "..", "src", "git", "nodeDependencies.ts"), PATH: `${join(dir, "bin")}:${process.env.PATH}`, CALLS: join(dir, "calls") } });
    assert.equal((await readFile(join(dir, "calls"), "utf8")).trim(), "test --if-present");
    assert.equal(nodeModulesReady(dir), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("dependency readiness invalidates when the lockfile changes", async () => {
  const { dependencyFingerprint } = await import("../src/git/provider.ts");
  const dir = await mkdtemp(join(tmpdir(), "nm-fingerprint-"));
  try {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "package-lock.json"), "first");
    const first = dependencyFingerprint(dir);
    await writeFile(join(dir, "package-lock.json"), "second");
    assert.notEqual(dependencyFingerprint(dir), first);
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
    await writeFile(join(dir, "node_modules", ".platform-ready"), dependencyFingerprint(dir)!);
    await writeFile(join(dir, "package-lock.json"), "changed");
    await writeFile(join(dir, "bin", "npm"), "#!/bin/sh\necho 'installation failed' >&2\nexit 1\n", { mode: 0o755 });
    process.env.PATH = `${join(dir, "bin")}:${previousPath}`;
    await assert.rejects(installNodeDependencies(dir), /installation failed/);
    assert.equal(nodeModulesReady(dir), false);
    await assert.rejects(readFile(join(dir, "node_modules", ".platform-ready")), { code: "ENOENT" });
  } finally {
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});
