import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTECTED_IN_WORKTREE } from "../src/agent/isolation.ts";
import {
  antigravityHookDecision,
  removeAntigravityWorkspaceConfig,
  writeAntigravityWorkspaceConfig,
} from "../src/agent/providers/antigravity/policy.ts";
import { copilotHookDecision } from "../src/agent/providers/copilot/policy.ts";
import type { PolicyContext } from "../src/agent/toolPolicy.ts";

const WS = "/work/tree";
const PROTECTED = "/work/main";

function policy(mode: "analysis" | "coding", extra: Partial<PolicyContext> = {}): PolicyContext {
  return { mode, workspaces: [WS], baseBranch: "main", protectedRoots: [PROTECTED], ...extra };
}

const decisions = [
  ["antigravity", antigravityHookDecision],
  ["copilot", copilotHookDecision],
] as const;

for (const [name, hook] of decisions) {
  test(`${name}: native write_file/edit_file follow the Write/Edit rule of the policy`, () => {
    for (const tool of ["write_file", "edit_file"]) {
      const inside = hook(
        { tool_name: tool, tool_input: { path: "src/a.ts" } },
        policy("coding"),
        WS,
      );
      assert.equal(inside.allow, true, `${tool} inside the worktree: ${JSON.stringify(inside)}`);
      const outside = hook(
        { tool_name: tool, tool_input: { path: "/etc/x" } },
        policy("coding"),
        WS,
      );
      assert.equal(outside.allow, false);
      assert.match(outside.reason ?? "", /worktree/);
      const ro = hook(
        { tool_name: tool, tool_input: { path: "src/a.ts" } },
        policy("analysis"),
        WS,
      );
      assert.equal(ro.allow, false);
    }
  });

  test(`${name}: list_dir, glob, grep and search_files cannot read a protected secret`, () => {
    for (const [tool, args] of [
      ["grep", { SearchPath: `${PROTECTED}/.env`, Query: "KEY" }],
      ["grep", { path: `${PROTECTED}/.env.production` }],
      ["search_files", { Path: `${PROTECTED}/config.json` }],
      ["list_dir", { DirectoryPath: `${PROTECTED}/credentials.json` }],
      ["glob", { path: `${PROTECTED}/deploy.pem`, Pattern: "*" }],
    ] as const) {
      const d = hook({ tool_name: tool, tool_input: args }, policy("analysis"), WS);
      assert.equal(d.allow, false, `${tool} ${JSON.stringify(args)}`);
    }
    const ok = hook(
      { tool_name: "grep", tool_input: { SearchPath: "src", Query: "x" } },
      policy("analysis"),
      WS,
    );
    assert.equal(ok.allow, true);
  });

  test(`${name}: inspection tools count against the tool budget and the loop detector`, () => {
    const toolBudget = { limit: 2, calls: 0, exhausted: false };
    const p = policy("analysis", { toolBudget });
    assert.equal(hook({ tool_name: "grep", tool_input: { path: "a" } }, p, WS).allow, true);
    assert.equal(hook({ tool_name: "list_dir", tool_input: { path: "b" } }, p, WS).allow, true);
    const third = hook({ tool_name: "glob", tool_input: { path: "c" } }, p, WS);
    assert.equal(third.allow, false);
    assert.match(third.reason ?? "", /budget/);
    assert.equal(toolBudget.exhausted, true);
  });
}

test("copilot: the native hook payload (toolName, toolArgs as a JSON string) goes through the same rules", () => {
  const view = copilotHookDecision(
    { toolName: "view", toolArgs: JSON.stringify({ path: `${PROTECTED}/.env` }) },
    policy("analysis"),
    WS,
  );
  assert.equal(view.allow, false);
  const create = copilotHookDecision(
    { toolName: "create", toolArgs: { path: "src/new.ts", file_text: "x" } },
    policy("coding"),
    WS,
  );
  assert.equal(create.allow, true, JSON.stringify(create));
  const readOnly = copilotHookDecision(
    { toolName: "edit", toolArgs: { path: "src/a.ts" } },
    policy("analysis"),
    WS,
  );
  assert.equal(readOnly.allow, false);
  const push = copilotHookDecision(
    { toolName: "bash", toolArgs: { command: "git push origin HEAD" } },
    policy("coding"),
    WS,
  );
  assert.equal(push.allow, false);
});

test("copilot: its per-attempt scratch directory is not readable", () => {
  const d = copilotHookDecision(
    {
      toolName: "bash",
      toolArgs: { command: "cat /tmp/ctp-copilot-scratch-ab12/mcp_config.json" },
    },
    policy("analysis"),
    WS,
  );
  assert.equal(d.allow, false);
});

test("the agent configuration directories a worktree could rewrite are read-only in the sandbox", () => {
  for (const dir of [".agents", ".github/hooks"])
    assert.ok(PROTECTED_IN_WORKTREE.includes(dir), dir);
});

test("antigravity: the workspace config is private to the owner and removed with the directory it created", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-cleanup-"));
  try {
    const { hookConfigPath, mcpConfigPath } = writeAntigravityWorkspaceConfig(dir, {
      brokerSocket: "/tmp/x.sock",
      brokerToken: "t",
      mode: "analysis",
    });
    for (const file of [hookConfigPath, mcpConfigPath])
      assert.equal(statSync(file).mode & 0o777, 0o600, file);
    removeAntigravityWorkspaceConfig(dir);
    assert.ok(!existsSync(join(dir, ".agents")));

    mkdirSync(join(dir, ".agents"));
    writeFileSync(join(dir, ".agents", "keep.md"), "repository file");
    writeAntigravityWorkspaceConfig(dir, {
      brokerSocket: "/x",
      brokerToken: "t",
      mode: "analysis",
    });
    removeAntigravityWorkspaceConfig(dir);
    assert.ok(existsSync(join(dir, ".agents", "keep.md")), "a repository's own .agents stays");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
