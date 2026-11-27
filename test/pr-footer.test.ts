import assert from "node:assert/strict";
import { test } from "node:test";
import { prDescription } from "../src/workflow/executors/builtin.ts";
import { providerAttribution } from "../src/agent/providerAttribution.ts";

const base = { runId: 7, summary: "s", decisions: [], commits: "abc x" };

test("the PR footer names the provider that ran the work", () => {
  assert.match(prDescription({ ...base, provider: "claude" }), /Generated with \[Claude Code\]/);
  assert.match(prDescription({ ...base, provider: "codex" }), /Generated with \[OpenAI Codex\]/);
  assert.match(
    prDescription({ ...base, provider: "copilot" }),
    /Generated with \[GitHub Copilot\]/,
  );
  assert.match(
    prDescription({ ...base, provider: "antigravity" }),
    /Generated with \[Google Antigravity\]/,
  );
  assert.match(prDescription({ ...base, provider: "cursor" }), /Generated with \[Cursor\]/);
  assert.doesNotMatch(prDescription({ ...base, provider: "codex" }), /Claude/);
});

test("without a provider the footer is the one PRs always had", () => {
  assert.match(
    prDescription(base),
    /Generated with \[Claude Code\]\(https:\/\/claude.com\/claude-code\)/,
  );
});

test("every provider has attribution with a name and an https link", () => {
  for (const p of ["claude", "codex", "cursor", "antigravity", "copilot"] as const) {
    const a = providerAttribution(p);
    assert.ok(a.name.length > 0);
    assert.match(a.url, /^https:\/\//);
  }
});
