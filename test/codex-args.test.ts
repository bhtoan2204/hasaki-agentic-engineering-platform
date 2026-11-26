import { test } from "node:test";
import assert from "node:assert/strict";
import { codexArgs } from "../src/agent/codex/run.ts";

test("Codex coding sandbox authorizes exact prepared worktrees on fresh and resumed turns", () => {
  const workspace = "/data/worktrees/run 123/repo";
  for (const resumeId of [undefined, "thread-123"]) {
    const args = codexArgs({
      mode: "coding",
      cwd: "/data/worktrees/run 123/agent-1174",
      scratch: "/tmp/codex-args",
      workspaces: [workspace, workspace],
      resumeId,
    });
    assert.ok(
      args.includes(`sandbox_workspace_write.writable_roots=[${JSON.stringify(workspace)}]`),
    );
    assert.ok(args.includes('sandbox_mode="workspace-write"'));
    assert.ok(args.includes('approval_policy="never"'));
    assert.ok(args.includes("sandbox_workspace_write.network_access=false"));
    assert.ok(args.some((arg) => arg.startsWith("hooks.PreToolUse=")));
  }
});

test("Codex analysis sandbox grants no worktree write access", () => {
  const args = codexArgs({
    mode: "analysis",
    cwd: "/data/agent",
    scratch: "/tmp/codex-args",
    workspaces: ["/data/worktrees/123/repo"],
  });
  assert.ok(args.includes('sandbox_mode="read-only"'));
  assert.ok(args.includes("sandbox_workspace_write.writable_roots=[]"));
});

test("Codex coding sandbox without prepared worktrees adds no write roots", () => {
  const args = codexArgs({ mode: "coding", cwd: "/data/agent", scratch: "/tmp/codex-args" });
  assert.ok(args.includes("sandbox_workspace_write.writable_roots=[]"));
});

test("the Codex MCP bridge process learns which optional capabilities are enabled (it reads no .env)", async () => {
  const { config } = await import("../src/config.ts");
  const { bridgeCapabilityEnv } = await import("../src/agent/mcpBridge.ts");
  const saved = { codeAct: config.codeAct.enabled, lsp: config.lsp.enabled };
  try {
    config.codeAct.enabled = true;
    config.lsp.enabled = false;
    const args = codexArgs({ mode: "analysis", cwd: "/data/agent", scratch: "/tmp/codex-args" });
    const env = args.find((a) => a.startsWith("mcp_servers.platform.env="));
    assert.match(env ?? "", /CODEACT_ENABLED="1"/);
    assert.match(env ?? "", /LSP_ENABLED="0"/);
    assert.deepEqual(bridgeCapabilityEnv(), { CODEACT_ENABLED: "1", LSP_ENABLED: "0" });
    // What the bridge then advertises follows those flags.
    const { spawnSync } = await import("node:child_process");
    const listed = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        'const { bridgeToolsFor } = await import("./src/agent/mcpBridge.ts"); console.log(JSON.stringify(bridgeToolsFor("analysis").map((t) => t.name)));',
      ],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, PLATFORM_TEST: "1", ...bridgeCapabilityEnv() },
      },
    );
    const names = JSON.parse(listed.stdout.trim().split("\n").at(-1) ?? "[]");
    assert.ok(names.includes("execute_code"), listed.stderr);
    assert.ok(!names.includes("navigate_code"));
  } finally {
    config.codeAct.enabled = saved.codeAct;
    config.lsp.enabled = saved.lsp;
  }
});
