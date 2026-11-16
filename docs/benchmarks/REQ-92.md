# Adaptive execution evaluation

`micro-change` is the compatible built-in workflow. MICRO admission requires one confirmed repository, `inputs.risk: "low"`, one to three canonical existing paths in `inputs.files`, a fresh Tree-sitter snapshot with matching source hashes, known bounded dependency impact, and no prior failed runs. File and symbol risk signals still override a declared low risk. Missing or stale evidence falls back conservatively. A short description or small diff does not establish eligibility.

Analysis, planning, implementation and self-review share one coding session. Verification and approval remain separate platform operations. Self-development workflows, configured agent boundaries, mandatory independent reviews, approval boundaries and consumers of removed phase contracts cannot be folded. The classifier may make one tool-less decision for uncertain implementation size only after deterministic safety evidence is sufficient; malformed responses, timeouts and missing impact cannot clear the guards.

MICRO caps injected context at 12,000 estimated tokens and execution at ten minutes, preserving stricter settings. Mandatory context overflow escalates rather than trimming required constraints. No subagents are allowed. The shared policy conservatively limits tool-policy decisions to twenty; repeated checks can consume this limit, while actual calls remain separately measured. Source edits require exact verified paths. Shell execution is denied because even a test or read command can execute repository code; bounded platform reads and explicit edit tools remain available. The trusted harness runs mandatory verification.

`escalate_profile` freezes the attempt at a checkpoint. Risk is reassessed before a locked-run transaction reconciles pending jobs and graph state. Existing workspace, branch, context snapshots, sessions, checkpoints and artifacts stay in place. Completed contracts remain valid only when unchanged. Incompatible completion, stale revisions, concurrent work or persistence failure pauses for reconciliation. A revised scope plan and bound human approval precede resumed coding; escalation grants no repository access. STANDARD and DEEP restore independent review. Transitions and reasons appear on the DAG, profile card and Trace Explorer.

After code changes, verification refreshes the bounded index overlay and checks actual changed paths and dependency impact. Unknown impact, scope growth or sensitive changes escalate; all workflow-defined mandatory commands remain required. The versioned workflow supplies targeted and broader commands. Routine MICRO reports use deterministic evidence rules, retaining PARTIAL/MISSING evidence when appropriate.

Run metrics expose initial/final profiles, transition segments, queue and provider durations, context estimates, verification duration and provider sessions. Missing provider telemetry stays null. Escalation and classification error are separate: accuracy requires independently adjudicated labels.

## Reproduce the orchestration control

```
node --disable-warning=ExperimentalWarning src/cli/bench.ts --suite=adaptive-v1 --fixture=true
```

This uses the existing scheduler and context pipeline with a test-owned PostgreSQL cluster, indexed local repository and scripted executors. It alternates profile order over twenty small fixtures, three repetitions and MICRO/FAST/STANDARD: 180 paired samples. No model is invoked. The checks establish approval retention and absence of source side effects, not correctness of an implemented business change. The committed JSON records actual orchestration timing and context estimates. Its invocation counts are scripted executor calls; tokens and verification duration are null. It is not evidence of live model time or token savings.

## Compare live measurements

```
node --disable-warning=ExperimentalWarning src/cli/bench.ts --suite=adaptive-v1 --samples=<sanitized-export.json>
```

The input contains `evidence: "live"` and `samples` (or `raw` from a previous report). Each sample records fixture, repetition, source base, provider, model, cold/warm cache condition, acceptance-check IDs, requested/effective profiles, wall/queue/active times, observed invocations, tokens, context size, verification duration, correctness and an independently adjudicated expected profile (nullable). See `ProfileSample` for the exact fields.

The command rejects unmatched revisions, providers, models, cache conditions, checks, missing profiles, fewer than twenty fixtures or fewer than three repetitions. Failed and escalated samples must remain in the export. It reports median/p95, coverage, observed improvements, correctness, fallback/escalation rates and adjudicated classification accuracy with raw measurements. Unknown telemetry is never replaced with zero.

Live measured-improvement acceptance remains unverified. The existing legacy live execution path is disabled because it does not enforce isolation and cost gates. This change does not relax that restriction or start workflows against the running application's database. A live comparison must use the existing approved isolated evaluation connector, then undergo independent evidence review.
