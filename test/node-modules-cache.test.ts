import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeModulesReady, installNodeDependencies } from "../src/git/provider.ts";
import { TEST_COMMAND } from "../src/workflow/templates.ts";

test("nodeModulesReady identifies package manager markers including .platform-ready", async () => {
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
    assert.equal(nodeModulesReady(dir), true);
    await rm(join(nm, ".platform-ready"));

    // .package-lock.json marker
    await writeFile(join(nm, ".package-lock.json"), "{}");
    assert.equal(nodeModulesReady(dir), true);
    await rm(join(nm, ".package-lock.json"));

    // .modules.yaml marker
    await writeFile(join(nm, ".modules.yaml"), "");
    assert.equal(nodeModulesReady(dir), true);
    await rm(join(nm, ".modules.yaml"));

    // .yarn-integrity marker
    await writeFile(join(nm, ".yarn-integrity"), "");
    assert.equal(nodeModulesReady(dir), true);
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
    await writeFile(join(nm, ".platform-ready"), "");

    assert.equal(await installNodeDependencies(dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workflow commands check .platform-ready to prevent redundant re-installation", () => {
  assert.ok(
    TEST_COMMAND.includes(".platform-ready"),
    "TEST_COMMAND must check for .platform-ready marker",
  );
  assert.ok(
    TEST_COMMAND.includes(".package-lock.json"),
    "TEST_COMMAND must check for .package-lock.json marker",
  );
});
