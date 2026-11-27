import assert from "node:assert/strict";
import { test } from "node:test";
import { completeForRun, type CompletionRunner } from "../src/agent/complete.ts";
import { legacyAgentConfiguration } from "../src/agent/configuration.ts";
import { AGENT_PROVIDERS, type AgentProvider } from "../src/agent/provider.ts";

const native = { tools: [], maxTurns: 2, call: async () => "" };

function seam() {
  const seen: Array<{ provider: string; nativeTools: boolean }> = [];
  const providers = Object.fromEntries(
    AGENT_PROVIDERS.map((provider) => {
      const runner: CompletionRunner = async (_prompt, options) => {
        seen.push({ provider, nativeTools: !!options.nativeTools });
        return { text: "x", model: "m", tokens: null };
      };
      return [provider, runner];
    }),
  ) as Record<AgentProvider, CompletionRunner>;
  return { providers, seen };
}

const run = (provider: AgentProvider) => ({
  agent_provider: provider,
  agent_configuration: legacyAgentConfiguration(),
});

test("native tools offered to a provider without them are not dropped silently: the completion says chat-tool", async () => {
  const { providers, seen } = seam();
  const codex = await completeForRun(
    run("codex"),
    "hi",
    undefined,
    providers,
    {},
    undefined,
    undefined,
    {
      nativeTools: native,
    },
  );
  assert.equal(codex.metrics.tool_protocol, "chat-tool");
  assert.equal(seen[0]?.nativeTools, false, "the runner is not handed tools it cannot serve");
});

test("native tools reach a provider that serves them, and the completion says native", async () => {
  const { providers, seen } = seam();
  const claude = await completeForRun(
    run("claude"),
    "hi",
    undefined,
    providers,
    {},
    undefined,
    undefined,
    {
      nativeTools: native,
    },
  );
  assert.equal(claude.metrics.tool_protocol, "native");
  assert.equal(seen[0]?.nativeTools, true);
});

test("a completion that offered no tools records no protocol", async () => {
  const { providers } = seam();
  const plain = await completeForRun(run("copilot"), "hi", undefined, providers);
  assert.equal(plain.metrics.tool_protocol ?? null, null);
});
