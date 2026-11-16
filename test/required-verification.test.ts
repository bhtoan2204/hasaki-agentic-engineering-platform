import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { verifyWorkspaces } from "../src/agent/verify.ts";

test("required verification rejects prose mentions, skipped tests and workspace mutation", async () => {
  const path = mkdtempSync(join(tmpdir(), "required-verification-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", path, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    writeFileSync(join(path, "source.txt"), "original");
    writeFileSync(join(path, "go.mod"), "module app\n\ngo 1.20\n");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    for (const scenario of [
      { output: "app/TestBusiness passed", passed: false },
      { output: JSON.stringify({ Action: "pass", Package: "app", Test: "TestBusiness" }) + "\n[output truncated]", passed: false },
      { output: JSON.stringify({ Action: "pass", Package: "app", Test: "TestBusiness" }), command: "node test.js", passed: false },
      { output: JSON.stringify({ Action: "skip", Package: "app", Test: "TestBusiness" }), passed: false },
      { output: JSON.stringify({ Action: "pass", Package: "app", Test: "TestBusiness" }), passed: true },
      { output: JSON.stringify({ Action: "pass", Package: "app", Test: "TestBusiness" }), mutate: true, passed: false },
    ]) {
      const result = await verifyWorkspaces([{ repo: "app", path }], [path], {
        command: scenario.command ?? "go test -json ./...", requiredTests: ["app/TestBusiness"], maxRepairs: 0,
        timeoutMs: 30000, baseline: null, allowTestWeakening: false,
      }, 0, new AbortController().signal, {
        run: async command => {
          if (command !== (scenario.command ?? "go test -json ./...")) return { code: 0, timedOut: false, output: "" };
          if (scenario.mutate) writeFileSync(join(path, "source.txt"), "changed during verification");
          return { code: 0, timedOut: false, output: scenario.output };
        }, diffTests: async () => "",
      });
      assert.equal(result.passed, scenario.passed, JSON.stringify(scenario));
    }
  } finally { rmSync(path, { recursive: true, force: true }); }
});
