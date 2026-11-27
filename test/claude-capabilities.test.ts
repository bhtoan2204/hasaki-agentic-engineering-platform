import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { config } from "../src/config.ts";
import { probeHandoffReadiness, probePreflightCapability } from "../src/agent/providerProbes.ts";

const original = config.agent.claudeBin;
const dirs: string[] = [];

afterEach(() => {
  config.agent.claudeBin = original;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeClaude(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  dirs.push(dir);
  const file = join(dir, "claude");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

test("a missing Claude binary is a binary failure, not a thrown error", async () => {
  config.agent.claudeBin = join(tmpdir(), "no-such-claude-binary");
  const result = await probePreflightCapability("claude", { model: "", effort: "" });
  assert.equal(result.ok, false);
  assert.equal((result as { kind?: string }).kind, "binary");
  assert.match(result.error ?? "", /cannot be started/);
  const readiness = await probeHandoffReadiness("claude", {});
  assert.equal(readiness.ok, false);
});

test("a signed-out Claude CLI is an auth failure", async () => {
  config.agent.claudeBin = fakeClaude(`echo '{"loggedIn": false}'`);
  const result = await probePreflightCapability("claude", { model: "", effort: "" });
  assert.equal(result.ok, false);
  assert.equal((result as { kind?: string }).kind, "auth");
  assert.match(result.error ?? "", /authentication/i);
});

test("a signed-in Claude CLI is ready; unreadable output is reported, not thrown", async () => {
  config.agent.claudeBin = fakeClaude(`echo '{"loggedIn": true}'`);
  assert.equal((await probePreflightCapability("claude", { model: "", effort: "" })).ok, true);
  assert.equal((await probeHandoffReadiness("claude", {})).ok, true);

  config.agent.claudeBin = fakeClaude("echo not-json");
  const broken = await probePreflightCapability("claude", { model: "", effort: "" });
  assert.equal(broken.ok, false);
  assert.equal((broken as { kind?: string }).kind, "error");
});
