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
    assert.ok(args.includes(`sandbox_workspace_write.writable_roots=[${JSON.stringify(workspace)}]`));
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
