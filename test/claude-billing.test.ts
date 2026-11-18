import { test } from "node:test";
import assert from "node:assert/strict";
import { agentEnvironment, paidClaudeAuth } from "../src/agent/environment.ts";

test("a Claude session that would bill per token is detected from its init message", () => {
  const init = (apiKeySource?: string) => ({ type: "system", subtype: "init", apiKeySource });
  assert.equal(paidClaudeAuth(init("none")), null, "subscription login");
  assert.equal(paidClaudeAuth(init(undefined)), null);
  assert.equal(paidClaudeAuth(init("ANTHROPIC_API_KEY")), "ANTHROPIC_API_KEY");
  assert.equal(paidClaudeAuth(init("apiKeyHelper")), "apiKeyHelper");
  assert.equal(paidClaudeAuth(init("/login managed key")), "/login managed key");
  assert.equal(paidClaudeAuth({ type: "assistant", apiKeySource: "ANTHROPIC_API_KEY" }), null);
});

test("cloud and gateway billing switches never reach any provider", () => {
  const env = agentEnvironment(
    {
      PATH: "/bin",
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_PROJECT_ID: "p",
      AWS_BEARER_TOKEN_BEDROCK: "t",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription",
    },
    "claude",
  );
  assert.deepEqual(env, { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "subscription" });
});
