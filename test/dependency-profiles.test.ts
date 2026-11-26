import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  FEATURE_MICRO_TARGETED_COMMAND,
  FEATURE_TARGETED_COMMAND,
  FEATURE_REGRESSION_COMMAND,
} from "../src/workflow/templates.ts";
import { recordDependencies } from "../src/git/provider.ts";

for (const [profile, command] of Object.entries({
  MICRO: FEATURE_MICRO_TARGETED_COMMAND,
  TARGETED: FEATURE_TARGETED_COMMAND,
  REGRESSION: FEATURE_REGRESSION_COMMAND,
})) {
  test(`${profile} installs changed dependencies once and reuses the new fingerprint`, async (t) => {
    const path = mkdtempSync(join(tmpdir(), "dependency-profile-"));
    t.after(() => rmSync(path, { recursive: true, force: true }));
    mkdirSync(join(path, "node_modules", "existing"), { recursive: true });
    mkdirSync(join(path, "bin"));
    writeFileSync(join(path, "package.json"), "{}");
    writeFileSync(join(path, "package-lock.json"), "original lock");
    await recordDependencies(path);
    const version = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
    const calls = join(path, "calls");
    writeFileSync(
      join(path, "bin", "npm"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\nprintf '%s\\n' "$*" >> "$CALLS"\n`,
      { mode: 0o755 },
    );
    const run = () =>
      execFileSync("bash", ["-c", command], {
        cwd: path,
        stdio: "pipe",
        env: {
          ...process.env,
          PLATFORM_NODE_DEPENDENCIES: join(
            import.meta.dirname,
            "..",
            "src",
            "git",
            "nodeDependencies.ts",
          ),
          BASE_BRANCH: "main",
          PLATFORM_SELF_TEST: "0",
          CALLS: calls,
          PATH: `${join(path, "bin")}:${process.env.PATH}`,
        },
      });
    writeFileSync(join(path, "package-lock.json"), "changed lock");
    run();
    run();
    writeFileSync(join(path, "package.json"), JSON.stringify({ description: "changed manifest" }));
    run();
    run();
    const installed = readFileSync(calls, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("ci ") || line.startsWith("install "));
    assert.equal(
      installed.length,
      2,
      "each changed lock or manifest requires exactly one install despite existing packages",
    );
    assert.equal(
      readFileSync(join(path, "package-lock.json"), "utf8"),
      "changed lock",
      "readiness must not fabricate or rewrite lock metadata",
    );
  });
}
