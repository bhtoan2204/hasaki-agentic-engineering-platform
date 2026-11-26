# CodeAct Live Pilot 2 — Claude Sonnet 5.5, 12 pairs

Run by the user on 2026-11-22 with the command proposed in
[codeact-e-summary-and-live-plan.md](codeact-e-summary-and-live-plan.md), on branch
`feat/codeact-diagnostics-eval-reliability` @ `9709aa5`. Raw report:
[codeact-live-pilot-2.json](codeact-live-pilot-2.json). This is **Level 4, live provider**: real model, real OS
sandbox, fixture data (no real SigNoz/Splunk).

## Validity

| Check | Result |
| --- | --- |
| Pairs | 12/12 complete, 0 incomplete, not stopped |
| Model check | **matched**: provider-reported `claude-sonnet-5-5` in all 24 samples, requested `claude-sonnet-5-5`, effort `medium`, 0 unresolved |
| Capability check | valid: Direct offered `code.execute` 0×, CodeAct not offered 0× |
| Budget | $3.380837 known spend of $5 limit, overshoot 0, unknown-cost samples 0 |
| Coverage | tokens, cache tokens, cost and model turns known for 24/24 |

## Intention-to-treat: CodeAct available vs not (paired, 12 pairs, bootstrap 95% CI)

| Metric (mean per sample) | Direct | CodeAct | Paired Δ | 95% CI |
| --- | --- | --- | --- | --- |
| Verified correct | 10/12 | 10/12 | 0 | [−0.25, 0.25] |
| Cost USD | 0.1613 | 0.1204 | −0.0409 | [−0.0954, −0.0011] |
| Model turns (inside the one SDK call) | 8.50 | 6.08 | −2.42 | [−5.00, −0.25] |
| Top-level tool calls | 7.42 | 5.08 | −2.33 | [−4.83, −0.25] |
| Tool-result chars delivered | 18,313 | 6,243 | −12,070 | [−26,255, −1,403] |
| Input tokens incl. cache | 132,704 | 111,829 | −20,875 | [−66,851, +13,516] |
| Cache-creation tokens | 33,955 | 24,920 | −9,035 | [−19,861, −915] |
| Output tokens | 1,539 | 1,178 | −361 | [−1,095, +193] |
| Latency ms | 17,729 | 14,147 | −3,582 | [−9,647, +1,114] |

SDK calls are 1 per sample in both variants. The native tool loop runs inside one SDK call, so model turns are the
meaningful count.

### Per task (2 repetitions each)

| Task | Correct D / C | Model turns D→C | Cost D→C | CodeAct used |
| --- | --- | --- | --- | --- |
| T01 single lookup (ineligible) | 2/2 / 2/2 | 3→3 | 0.0996→0.1005 | 0/2 |
| T03 trace/log correlation | 1/2 / **0/2** | 8→6 | 0.1392→0.1258 | 2/2 |
| T06 refund timeout | 2/2 / 2/2 | 11→10.5 | 0.1698→0.1680 | 2/2 |
| T08 large aggregation | 1/2 / 2/2 | 17.5→6 | **0.3417→0.1161** | 2/2 |
| T09 partial failure | 2/2 / 2/2 | 8→8 | 0.1280→0.1229 | 2/2 |
| T10 CodeAct unnecessary (ineligible) | 2/2 / 2/2 | 3.5→3 | 0.0897→0.0890 | 0/2 |

## Adoption and failures (CodeAct variant)

- Adoption: 8/8 eligible turns used CodeAct (Wilson 95% [0.68, 1.00]). 0/4 ineligible turns (T01, T10) used it.
- Executions: 15 in total, 2 failed. Both were in T06, both `program_runtime_error ← eval.traces /
  tool_invocation_failed`, which is consistent with the fixture's refund-worker HTTP 503.
- Both failures were followed by exactly one corrected program (`recovered`), and both turns ended correct. There were
  no fallbacks, no abandoned failures and no unknown sequences.
- Nested failures handled inside successful programs: 6.

## Interpretation (descriptive: 12 pairs, 6 tasks)

- **Correctness:** no difference (10/12 each).
- **Cost:** −25% per sample on average, but the saving is concentrated in **T08** (−$0.226 per sample: 17.5→6 model
  turns, because Direct paged through truncated results). The other tasks differ by −$0.013 to +$0.001. The CI excludes
  0, but with 12 pairs dominated by one task it is not a general claim.
- **Latency and total input tokens:** CIs include 0, so there is no claim.
- **Guidance compliance:** ineligible tasks were never sent to CodeAct and eligible ones always were. The previous pilot
  used a different, unknown model and no new guidance, so the change **cannot be attributed** to the guidance.
- **Usage outcomes** (observational): every eligible turn used CodeAct, so there is no non-user group to compare.

## Open finding: T03 CodeAct 0/2 (likely a grading artifact, NOT confirmed)

Both T03 CodeAct samples had `count` right and `order_ids` wrong. The question asks for "sorted ids". The reference
sorts **lexicographically** (`ORD-101, …, ORD-17, ORD-29, …, ORD-5, …`). A numerically sorted, otherwise identical
list would be graded wrong, and the direct sample that was graded correct may simply have sorted the same way as the
reference.

This cannot be checked: the report stores the graded field booleans, not the answer. Proposed fix, not applied:
- Grade identifier lists as sets.
- Keep the parsed (fixture-only) answer in each raw sample.

Then re-run T03 if a confirmation is wanted.

## Limitations

- Fixture data only. One provider and one model. 2 repetitions per task.
- Bootstrap CIs over 12 non-independent pairs (6 tasks × 2).
- No comparison with pilot 1: different model, and that model is unknown.
