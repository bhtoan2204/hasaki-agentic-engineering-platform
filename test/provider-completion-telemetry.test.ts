import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { antigravityComplete } from "../src/agent/providers/antigravity/complete.ts";
import { resetCapabilitiesCache as resetAgy } from "../src/agent/providers/antigravity/capabilities.ts";
import { codexComplete } from "../src/agent/providers/codex/complete.ts";
import { codexCapabilities } from "../src/agent/providers/codex/capabilities.ts";
import { copilotComplete } from "../src/agent/providers/copilot/complete.ts";
import { resetCapabilitiesCache as resetCopilot } from "../src/agent/providers/copilot/capabilities.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const KEYS = [
  "COPILOT_BIN",
  "FAKE_COPILOT_MODE",
  "AGY_BIN",
  "FAKE_AGY_MODE",
  "CODEX_BIN",
  "FAKE_CODEX_MODE",
];

beforeEach(async () => {
  process.env.COPILOT_BIN = join(fixtures, "fake-copilot.mjs");
  process.env.AGY_BIN = join(fixtures, "fake-agy.mjs");
  process.env.CODEX_BIN = join(fixtures, "fake-codex.mjs");
  resetCopilot();
  resetAgy();
  await codexCapabilities(true);
});
afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

test("copilotComplete keeps the usage of the checkpoint when the result event has none", async () => {
  process.env.FAKE_COPILOT_MODE = "aux_real";
  const r = await copilotComplete("hi", { timeoutMs: 20_000 });
  assert.equal(r.text, "ok");
  assert.deepEqual(r.tokens, {
    input: 3,
    output: 5,
    reasoning_output: 0,
    cache_read: 10175,
    cache_creation: 7099,
  });
});

test("copilotComplete reports provider telemetry, with nulls for what the CLI does not report", async () => {
  process.env.FAKE_COPILOT_MODE = "aux_real_tools";
  const r = (await copilotComplete("hi", { timeoutMs: 20_000 })) as unknown as {
    telemetry: Record<string, unknown>;
  };
  assert.equal(r.telemetry.session_model, "gpt-fake-1");
  assert.deepEqual(r.telemetry.api_models, ["gpt-fake-1"]);
  assert.equal(r.telemetry.model_turns, 1);
  assert.equal(r.telemetry.provider_tool_uses, 2);
  assert.equal(r.telemetry.provider_duration_ms, 2451);
});

test("copilotComplete returns the session id only when the caller keeps the session", async () => {
  process.env.FAKE_COPILOT_MODE = "aux_real";
  const kept = (await copilotComplete("hi", {
    timeoutMs: 20_000,
    session: { keep: true },
  })) as unknown as {
    session_id?: string | null;
  };
  assert.equal(kept.session_id, "copilot-sess-1");
  const dropped = (await copilotComplete("hi", { timeoutMs: 20_000 })) as unknown as {
    session_id?: string | null;
  };
  assert.equal(dropped.session_id ?? null, null);
});

test("antigravityComplete reports telemetry and the conversation id of a kept session", async () => {
  process.env.FAKE_AGY_MODE = "aux_complete";
  const r = (await antigravityComplete("hi", {
    timeoutMs: 20_000,
    session: { keep: true },
  })) as unknown as {
    telemetry: Record<string, unknown>;
    session_id?: string | null;
    tokens: Record<string, number | null> | null;
  };
  assert.equal(r.telemetry.session_model, "gemini-3.8-flash-high");
  assert.equal(r.telemetry.model_turns, null);
  assert.equal(r.telemetry.provider_tool_uses, 0);
  assert.ok(r.session_id);
  assert.equal(r.tokens?.input, 25);
});

test("codexComplete reports turns and tool uses, and never invents a model the CLI does not report", async () => {
  process.env.FAKE_CODEX_MODE = "complete";
  const r = (await codexComplete("hi", { timeoutMs: 20_000 })) as unknown as {
    telemetry: Record<string, unknown>;
  };
  assert.equal(r.telemetry.model_turns, 1);
  assert.equal(r.telemetry.provider_tool_uses, 0);
  assert.equal(r.telemetry.session_model, null);
  assert.deepEqual(r.telemetry.api_models, []);
});
