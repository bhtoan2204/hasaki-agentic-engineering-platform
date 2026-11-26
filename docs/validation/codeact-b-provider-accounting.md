# CodeAct B — Provider, Model, Turn and Token Accounting

Branch `feat/codeact-diagnostics-eval-reliability`, 2026-11-22. Deterministic telemetry fixtures; no paid provider call.

## Root causes (confirmed in source)

| Problem                                  | Why                                                                                                                                                                                                                                                                                       | Evidence                                                                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `model: null` in the live report         | The sample recorded the **requested** model (`o.model ?? null`). The pilot requested none (account default), so it was null. What the provider reported (`init.model`, API message `model`) was dropped. The chat turn's `metrics.model` was also the requested model (`resolved.model`). | `src/eval/codeactEffect.ts` (before) `model: o.model ?? null`; `src/chat/runtime.ts` `model: attempts.find(ok)?.model ?? admission.model` |
| `completions = 1` for every live sample  | `completions` counts chat-harness SDK calls. With native tools, one Claude Agent SDK `query()` runs the whole tool loop: several model turns and tool uses. `claudeComplete` returned no turn data, although the SDK reports `num_turns` and per-message ids.                             | Pilot: `completions: 1` with up to 10 tool calls in the same sample                                                                       |
| Cache tokens missing from the comparison | Cache read/creation tokens were in raw samples but not in the summary metrics, which compared only uncached `input_tokens` (6–16 per sample against about 30k–200k cache reads).                                                                                                          | Pilot raw samples vs `variants.*.metrics`                                                                                                 |

## What changed

- `src/agent/metrics.ts`: `providerTelemetry(m)` reads the provider's own events:
  - `model_turns` comes from the result's `num_turns`.
  - `assistant_messages` counts distinct API message ids in the main session; streamed blocks of one message count
    once.
  - `provider_tool_uses` and `provider_tool_errors`.
  - `session_model` comes from `init`.
  - `api_models` come from API messages; this is where an alias resolves.
  - `provider_duration_ms` and `reasoning_tokens` are included.
  - With no result event (interruption), turns and duration are null. The requested model is never substituted.
  - Replays are still deduplicated by SDK uuid (existing mechanism).
- `src/agent/complete.ts`: `claudeComplete` returns `telemetry`, and `Completion.metrics.telemetry` carries it. Other
  providers return none, so their values are null.
- `src/chat/runtime.ts`, `src/chat/types.ts`:
  - `ChatUsage.model_turns` and `provider_tool_uses` are null-propagating: one completion without telemetry makes them
    unknown. Totals recorded before this change count as unknown, not 0.
  - Per-step `provider_models` and `model_turns` are recorded.
  - Turn metrics get `provider_models` and `model_resolution` (`provider_reported` | `unresolved`). `model` keeps its
    old meaning (requested).
- `src/eval/codeactEffect.ts`:
  - Samples get `requested_model`, `effort`, `provider_models`, `model_resolution`, `sdk_calls` (was `completions`),
    `model_turns`, `provider_tool_uses`, `input_tokens_total` (uncached + cache read + cache write, null if any part is
    unknown) and `codeact_offered`.
  - Summary metrics add verified correctness (1/0, paired), turns, tool uses, cache tokens and `input_tokens_total`.
  - `model_check` reports `matched` / `mismatched` / `unverified`. A comparison is model-matched only when every
    complete pair has the same provider-reported models, effort and request. The Markdown says "NOT model-matched" or
    "model identity unverified".
  - Cost is only what the provider reports (`total_cost_usd`). Prompt characters stay labeled as characters and the
    token estimate as an estimate.

## Verification

| Level | Command                                                                 | Exit | Result                                                                                                                                                                                                                                                                          |
| ----- | ----------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `node --import ./test/env.ts --test test/provider-telemetry.test.ts`    | 0    | 6/6: native tool loop in one completion (3 turns, 2 tool uses), streamed blocks and replayed result deduplicated, cache present and absent, alias (`opus` → session `claude-opus-5-5` → API `claude-opus-5-5-20261101`), interruption → null turns, chat usage null propagation |
| 1     | `node --import ./test/env.ts --test test/codeact-effect-report.test.ts` | 0    | 4/4: matched, different models → `mismatched`, unresolved → `unverified`, interrupted sample → unknown usage excluded and correctness diff −1                                                                                                                                   |
| 2     | `node test/run-integration.ts test/codeact-effect.integration.ts`       | 0    | 9/9: telemetry flows runner → chat turn metrics → sample, including a turn with a failed CodeAct program; a provider with no telemetry stays unknown                                                                                                                            |
| –     | `npm test`                                                              | 0    | 1163/1163                                                                                                                                                                                                                                                                       |
| –     | `tsc`, `npm run lint`                                                   | 0    | clean                                                                                                                                                                                                                                                                           |

## Limitations

- Only the Claude runner exposes per-completion telemetry. Codex, Cursor, Antigravity and Copilot report null
  turns/models through this path.
- Claude reports no separate reasoning-token count in `result.usage`, so `reasoning_tokens` stays null there.
- `api_models` depends on the SDK forwarding the API message's `model` field. If a future SDK drops it, the session
  model is used and, failing that, the sample is `unresolved`.
- The historical live pilot cannot be re-derived: its database was dropped (see the A report).
