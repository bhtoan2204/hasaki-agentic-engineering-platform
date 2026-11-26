# CodeAct P0 — Correctness and Evidence Verification Fixes

Branch `fix/codeact-p0-grading-evidence-sufficiency` from `main` @ `d5d1c07`, 2026-11-22. Deterministic fixtures, the
private PostgreSQL cluster, no paid provider call.

## 1. T03 (trace/log correlation): CodeAct 0/2 in live pilot 2

### What the pilot shows

Both T03 CodeAct samples had `fields: {order_ids: false, count: true}`, `unsupported: 0`. The report did not store the
answers, and the pilot's database was dropped when the process exited. **The model's actual answers are not
recoverable.**

### Reconstruction from the fixture

- `referenceAnswer(T03)` gives `{order_ids: [ORD-101, ORD-113, ORD-125, ORD-137, ORD-149, ORD-17, ORD-29, ORD-41,
  ORD-5, ORD-53, ORD-65, ORD-77, ORD-89], count: 13}`.
- It is sorted with JavaScript's default `.sort()`, which is **lexicographic**.
- The output contract said `"order_ids": [sorted ids]` without defining the order.

Every plausible reading of the question was computed on the fixture, each giving 13 ids, **the same set as the
reference**:
- `>= 5000` vs `> 5000` ms;
- spans from any service;
- logs from any service;
- logs containing only "timeout";
- either source alone.

| Possible cause | Can it give count 13 with wrong `order_ids`? |
| --- | --- |
| Wrong membership from a misread filter | No: every reading above gives the reference set |
| Missing ids | No: the set would be smaller, but count was right |
| Extra ids | No: the set would be larger, but count was right |
| Duplicates | Only with a count inconsistent with the list, or a deduplicated count |
| Pagination or truncation | No: CodeAct answers come from complete program results, and a cut list changes the set |
| Wrong tool arguments | No: covered by the readings above |
| **Ordering** (e.g. natural `ORD-5, ORD-17, …`) | **Yes** |
| Id formatting (e.g. numbers without `ORD-`) | Yes |

**Root cause demonstrated (grader).** The old grader compared the whole list by exact JSON. It rejects the correct
set, with the correct count, in natural numeric order:

```
before: gradeAnswer(ref, {order_ids: <same 13 ids, natural order>, count: 13})
        → correct: false, fields.order_ids: false
```

This is a defect in the task specification: "sorted" had no defined order, and order carries no meaning for "which
orders". Whether the pilot's answers were ordered differently or formatted differently **is not proven**: that needs a
fresh live run with the answers now recorded.

**A benchmark weakness found on the way.** In this fixture the slow gateway orders and the timeout-logged orders are
the same 13. T03 therefore does not actually require a correlation: either source alone answers it. This is fixed with
discriminating incidents in P1, not by changing T03's reference.

### What changed

- `src/eval/codeactTasks.ts`: each task declares how fields are graded (`grading`).
  - `set`: identifier lists whose order carries no meaning. Same members, **duplicates rejected separately**.
  - `ordered`: rankings (T05 `top`).
  - `count` (with `of`): must equal the reference, and is checked for consistency with the answer's own list.
  - The output contracts state the same semantics: "each once, any order" or "ordered by count descending, ties by
    message ascending". "sorted" without a defined order no longer appears.
  - References are unchanged, and no answer is hardcoded into prompts or CodeAct.
- `gradeAnswer(expected, answer, rules)` returns per-field `diagnostics`: expected, actual, missing, unexpected,
  duplicates, `order_differs`, and count `consistent_with`.
- `src/eval/codeactEffect.ts`:
  - Both variants are graded with `task.grading`.
  - Every sample keeps `grading` (the diagnostics) and `answer` (the parsed answer block, fixture-only, capped at
    4,000 chars).

### Tests

`node --import ./test/env.ts --test test/codeact-grading.test.ts`, 8/8:
- **Before:** the old rule rejects the natural order (kept as a regression record).
- **After:**
  - Lexicographic, natural and reversed orders of the right set are correct.
  - Missing (`["ORD-101"]`), extra (`["ORD-3"]`) and duplicate (`["ORD-5"]`) ids are rejected, each diagnosed.
  - Right count with wrong membership is rejected.
  - A wrong count is diagnosed as inconsistent with the list.
  - Empty sets match only empty sets, and `null` is not `[]`.
  - A reordered ranking (T05) is still wrong.
  - Every `set` / `ordered` field's question states its order semantics.
  - Unanswered stays wrong, and unsupported non-null fields are still counted.

`node test/run-integration.ts test/codeact-effect.integration.ts`, 13/13. Through the real Chat harness:
- The T03 reference is rebuilt from the fixture.
- A **paginated** CodeAct correlation (pages of 50 over every slow span and timeout log, natural order) is graded
  correct, with `order_differs: true` in the diagnosis and the answer kept.
- The Direct variant carries the same diagnosis.
- An **empty intersection** is solved and graded exactly.
- Partial integration failure (T09) and large aggregation (T08) remain in the paired run.

```
T03-GRADING codeact.order_ids: missing [], unexpected [], duplicates [], order_differs true;
            count: expected 13, actual 13, consistent_with {field: order_ids, distinct: 13, consistent: true}
```

## 2. Evidence report false PASS

### Root cause

`buildEvidenceReport` returned `failures ? failed : missing_evidence ? incomplete : passed`. `missing_evidence` is
what the **agent** declares. With no contradiction and nothing declared missing, the verdict was `passed`, whatever
was or was not verified. Also, provenance `AGENT_REPORTED` keeps `verification_status: verified`, so a CONFIRMED root
cause could rest entirely on facts only the agent vouched for.

Before the fix (the same tests run against the old code; status returned):

| Case | Old verdict |
| --- | --- |
| zero claims, zero evidence | **passed** |
| required source (log) without verified fact | **passed** |
| truncated record as only trace evidence | **passed** |
| verified DB-pool observation + unsupported causal conclusion | **passed** |
| partial outage (SigNoz call failed) | **passed** |
| CONFIRMED on agent-vouched facts only | **passed** |
| root cause PROBABLE | **passed** |
| default objectives, `missing_evidence: []` | **passed** |

### What changed (existing provenance and normalization; no new engine)

- `EvidenceObjectives` are declared by the workflow step config (trusted), never by the agent:
  - `required_sources` (trace / log / metric / code);
  - `require_root_cause` (default true);
  - `min_verified_facts` (default 1).
  - The `incident-investigation` template declares trace, log and code.
- A fact's source family comes from what the platform knows: a verified code location, or `provenance.source_tool`,
  read from the cited record (`code_execution_calls.tool`, `agent_context_tool_calls.tool`). It never comes from the
  agent's `source_type`.
- **failed:** contradiction, a citation absent from this run (fabricated or another run's), a lowered conclusion, or a
  CONFIRMED root cause with **no** platform-verified support.
- **incomplete:** any of:
  - fewer platform-verified facts than required;
  - a required family not covered (outage, truncated, stale);
  - no root cause, or a root cause that is not CONFIRMED;
  - a CONFIRMED root cause whose supports lack an independently checked observation or location, or do not cover
    every required family;
  - evidence the agent declared missing.
- **passed:** every objective met. `verification.sufficiency` reports objectives, covered and missing sources,
  `root_cause_supported` and reasons.

### Tests

`node --import ./test/env.ts --test test/evidence-sufficiency.test.ts`, 14/14 (8 failed before the fix, as above):
- zero claims → incomplete;
- claims without references → not passed;
- fabricated CodeAct ref → failed;
- another run's ref → failed;
- missing required source → incomplete;
- truncated source → incomplete;
- stale code location (real git repository, file changed since the cited commit) → incomplete;
- contradictory observation → failed;
- correct observation with unsupported causal conclusion → not passed, `root_cause_supported: false`;
- partial outage → incomplete;
- CONFIRMED on agent-vouched facts → failed;
- PROBABLE → incomplete;
- valid supported root cause → passed;
- default objectives with `missing_evidence: []` → incomplete.

Integration (`incident-investigation`, `codeact-evidence`, `codeact-diagnostics`, `codeact-composition`,
`codeact-pairing`, `codeact-effect`), 47/47:
- The M4 end-to-end run 1 stays `incomplete` (SigNoz unavailable for refund-worker). Sufficiency now shows code, log
  and trace covered, with `root_cause_supported: true`.
- The deliberately wrong diagnosis stays `failed`.

## Gate

| Requirement | Status |
| --- | --- |
| T03 root cause demonstrated | Grader defect demonstrated. The pilot's exact answers are unrecoverable, so they are NOT VERIFIED until a fresh live run with recorded answers. |
| Grading semantics correct, incorrect answers still rejected | yes (tests above) |
| Deterministic correlation tests pass | yes |
| Evidence false PASS prevented | yes |
| CodeAct authorization and evidence integrity intact | yes: evidence, composition, diagnostics and pairing suites unchanged and passing |
| No regression | `npm test` 1191/1191; tsc, lint, arch clean |

## Limitations

- The live T03 outcome after the fix is **NOT RUN**: it needs an authorized budget. The proposed command is the T03
  subset of the pilot with `--tasks T03-trace-log-correlation --repetitions 2 --max-samples 4`, about $1.
- Source families are derived from tool names by pattern (trace/span/signoz…, log/splunk…). An integration with an
  unrecognized name contributes no family, and so cannot satisfy a requirement. This is the safe direction.
