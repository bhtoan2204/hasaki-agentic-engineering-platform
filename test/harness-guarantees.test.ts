import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GUARANTEES,
  guaranteeCheck,
  NATIVE_TOOL_PROVIDERS,
  OS_ISOLATED_PROVIDERS,
  PROVIDER_CAPABILITIES,
  providerCapabilities,
  providerControls,
  VISION_PROVIDERS,
} from "../src/agent/providerCapabilities.ts";
import { discoverProviderAdapter } from "../src/agent/providerProbes.ts";
import { decide, type PolicyContext } from "../src/agent/toolPolicy.ts";

const PROVIDERS = ["claude", "codex", "cursor", "copilot", "antigravity"] as const;

test("every provider declares its guarantees", () => {
  assert.deepEqual(Object.keys(GUARANTEES).sort(), [...PROVIDERS].sort());
});

test("write steps fail closed on a provider that cannot enforce pre-execution policy", () => {
  for (const provider of ["claude", "codex", "copilot", "antigravity"] as const)
    assert.deepEqual(guaranteeCheck(provider, "coding").unmet, [], provider);
  assert.deepEqual(guaranteeCheck("cursor", "coding").unmet, [
    "pre_tool_policy",
    "hook_bypass_detection",
  ]);
});

test("read-only steps run degraded instead of failing, and say what is missing", () => {
  const cursor = guaranteeCheck("cursor", "analysis");
  assert.deepEqual(cursor.unmet, []);
  assert.deepEqual(cursor.degraded, ["pre_tool_policy", "hook_bypass_detection"]);
  assert.deepEqual(guaranteeCheck("codex", "analysis").degraded, []);
});

test("a sandbox the step turned off is a missing write guarantee", () => {
  assert.deepEqual(guaranteeCheck("copilot", "coding", { sandbox: false }).unmet, [
    "write_sandbox",
  ]);
  assert.deepEqual(guaranteeCheck("antigravity", "analysis", { sandbox: false }).unmet, []);
  assert.deepEqual(guaranteeCheck("claude", "coding", { sandbox: false }).unmet, []);
});

test("web tools are denied while a step can write, unless the step allows network", () => {
  const coding: PolicyContext = { mode: "coding", workspaces: ["/w"], baseBranch: "main" };
  assert.equal(decide("WebFetch", { url: "https://x" }, coding).allow, false);
  assert.equal(decide("WebSearch", { query: "x" }, { ...coding, network: true }).allow, true);
  assert.equal(decide("WebSearch", { query: "x" }, { ...coding, mode: "analysis" }).allow, true);
});

test("PROVIDER_CAPABILITIES is complete and consistent with derived capability tables", () => {
  assert.deepEqual(Object.keys(PROVIDER_CAPABILITIES).sort(), [...PROVIDERS].sort());
  assert.deepEqual(Object.keys(providerControls).sort(), [...PROVIDERS].sort());
  for (const p of PROVIDERS) {
    const caps = providerCapabilities(p);
    assert.equal(caps.id, p);
    assert.deepEqual(providerControls[p].efforts, [...caps.controls.efforts]);
    assert.deepEqual(providerControls[p].options, [...caps.controls.options]);
    assert.equal(providerControls[p].max_turns, caps.controls.max_turns);
    assert.equal(providerControls[p].model, caps.controls.model);
    assert.equal(VISION_PROVIDERS.includes(p), caps.completion.visionImages);
    assert.equal(NATIVE_TOOL_PROVIDERS.includes(p), caps.completion.chatNativeTools);
    assert.equal(OS_ISOLATED_PROVIDERS.includes(p), caps.guarantees.osIsolation);
    assert.equal(GUARANTEES[p].includes("reported_cost"), caps.completion.reportedCost);
    assert.equal(GUARANTEES[p].includes("pre_tool_policy"), caps.guarantees.preToolPolicy);
    assert.equal(typeof discoverProviderAdapter(p).bin, "string");
  }
  assert.equal(providerCapabilities("claude").guarantees.delegation, true);
  for (const p of ["codex", "copilot", "antigravity", "cursor"] as const) {
    assert.equal(providerCapabilities(p).guarantees.delegation, false);
  }
  assert.equal(providerCapabilities("cursor").guarantees.microProfile, false);
  assert.equal(providerCapabilities("cursor").guarantees.allowedToolsEnforcement, "unsupported");
});
