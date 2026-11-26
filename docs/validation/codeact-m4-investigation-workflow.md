# CodeAct M4 — Evidence-driven Investigation Workflow

Branch `feat/codeact-evidence-eval-composition` (after M3 `02a0c33`), 2026-11-22, WSL2 Linux 6.6.114.1, Node v22.23.5,
private PostgreSQL cluster, platform-go, real bubblewrap OS sandbox for CodeAct (`sandbox: os-sandbox` in the run).

## Design (extension, not a new orchestrator)

| Piece                                                                                                                                                                                                | Where                                                                                          | Reused                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Template `incident-investigation`: `discover` → `investigate` (read-only `agent`, `evidence: "root_cause"`) → `report` (`integration`, `action: evidence_report`)                                    | `src/workflow/templates.ts`                                                                    | engine, scheduler, checkpoints/replay, repository discovery, agent harness, providers, context pack |
| Stages A–D in one agent step: collect (CodeAct when several lookups combine), correlate, code + knowledge correlation (M3 composition), root-cause assessment with supporting/contradicting evidence | `INCIDENT_INVESTIGATE` instructions/contract                                                   | evidence claim model (`src/agent/evidence.ts`), M1 refs, M3 composition                             |
| Claim provenance for `codeact:<execution>:<seq>` + deterministic `observed: {pointer, equals \| count \| includes}` checks on the recorded result                                                    | `src/agent/provenance.ts`                                                                      | harness output stage (already runs provenance then evidence normalization for evidence-role steps)  |
| Stage E–F: re-verify every claim at report time, re-normalize (only lowers certainty), report confirmed facts / hypotheses / unverified / contradicted / missing evidence / verdict                  | `src/agent/evidenceReport.ts`, `evidence_report` action in `src/workflow/executors/builtin.ts` | `withProvenance`, `normalizeInvestigationOutput`                                                    |

A CodeAct citation is VERIFIED only for an `ok`, recorded call of a finalized execution **of the same run**; a
mismatching `observed` value is CONTRADICTED with what the record actually shows; a truncated record cannot confirm an
observation (UNVERIFIED). Verification verdict: `failed` when any claim is contradicted or the platform had to lower a
conclusion (CONFIRMED_ROOT_CAUSE without verified support, root-cause caps); `incomplete` when evidence is missing;
otherwise `passed`. The workflow changes nothing (`production_changes: "none"`); remediation goes through the existing
approved coding workflow.

### Pre-existing defect found and fixed: Codex/Cursor never saw CodeAct or LSP

The provider MCP bridges run in their own process with a minimal environment (no `.env`), so they evaluated
`codeAct.enabled` / `lsp.enabled` as off and refused `execute_code` / `navigate_code` ("unknown platform tool"), while
the worker had listed them in Codex's `enabled_tools`. The worker now passes `CODEACT_ENABLED` / `LSP_ENABLED`
(`bridgeCapabilityEnv()`) to both bridges; the broker still authorizes every call. Test:
`test/codex-args.test.ts` (RED before the fix, GREEN after).

## Verification

| Level                     | Command                                                                                      | Exit | Result                             |
| ------------------------- | -------------------------------------------------------------------------------------------- | ---- | ---------------------------------- |
| 1 Unit                    | `node --import ./test/env.ts --test test/provenance-codeact.test.ts test/codex-args.test.ts` | 0    | 3/3, 4/4                           |
| 2–3 Integration + runtime | `node test/run-integration.ts test/incident-investigation.integration.ts`                    | 0    | 3/3 (OS sandbox)                   |
| Regression                | `npm test`                                                                                   | 0    | 1132/1132                          |
| Static                    | `tsc` (root, web), `npm run lint`, `npm run arch:check`                                      | 0    | 5 cycles / 6 violations (baseline) |

The end-to-end test drives the real engine and scheduler with the Codex provider path: the fake `codex` CLI
(`FAKE_CODEX_MODE=script`) scripts the agent's tool use, but every call goes through the platform's real MCP bridge,
hook, broker, `dispatchPlatformTool`, CodeAct surface and OS sandbox; the harness's provenance/normalization and the
`report` step are production code. **The agent's reasoning is scripted, not a model (Level 4 NOT VERIFIED).**

Acceptance mapping (test names in `test/incident-investigation.integration.ts`):

1. Starts through the existing engine — `startRun` of the template; scheduler `runOnce`; run `COMPLETED`.
2. Only authorized tools — a mutating integration call from the read-only step is refused
   (`inc.publish changes external state and is not allowed in a read-only step`), the handler never ran.
3. Bounded CodeAct aggregation — one execution, 6 nested calls, `evidence_status: complete`.
4. Code Intelligence returns the owning source location, verified at its commit (`verifies: location`).
5. Knowledge is composable with freshness rules (M3 tests); the business rule is in the run's context pack.
6. Evidence references resolve — every `codeact:` ref in the agent output and the report resolves for the owner.
7. Facts vs hypotheses — `H1` stays a hypothesis; mitigation ("raise the timeout") is listed as a rejected candidate.
8. Misleading observation — the DB-pool warning is checked (`count: 0` overlap, verified) and does not become a cause.
9. Partial integration failure — SigNoz 503 for refund-worker → `missing_evidence`, verdict `incomplete`.
10. Cancellation — cancelling the run during collection ends the program (`code_executions` `error/canceled`) and the
    run (`CANCELED`).
11. Checkpoint/resume — re-executing `report` from the persisted investigation yields the same verdict and facts.
12. No mutation without the approval path — see 2; the workflow has no write step.
13. Deliberately incorrect conclusion detected — see the second test below.
14. Existing workflows — full integration suite `npm run test:integration`: 929/932 pass. The 3 failures are
    pre-existing/environmental and reproduce identically on the base commit `f666c65`: `test/evaluation.integration.ts`
    "Fixture evaluations use existing jobs…" and "Two evaluations can execute concurrently…" (same 2 failures on
    `f666c65`), and `test/repository-remotes.integration.ts` "legacy dry-run…" (a `url.insteadOf` rule in the host's
    global git config; passes with `GIT_CONFIG_GLOBAL=/dev/null`).

### Evidence (fixture database)

Correct diagnosis, run 1 (OS sandbox):

```
verification {"status":"incomplete","failures":[],"claims_checked":6,"platform_verified":4}
root_cause   {"status":"CONFIRMED","supporting_claims":["R1","F2"]}
confirmed    F1 codeact:1:1 (observation: 13 slow gateway.refund orders), F2 codeact:1:2 (observation:
             provider.refund.http), F3 codeact:1:3 (observation: 0 DB-pool overlaps),
             K1 payments-svc:provider/client.go:4-6@0b437795ef13 (location)
missing      refund-worker traces: SigNoz unavailable for refund-worker (HTTP 503)
```

Deliberately wrong diagnosis ("DB pool saturation; raise the timeout"), run 2:

```
verification failed:
  W1 codeact:2:3: the cited record has 0 items at /events, not 7
  W2 codeact:999999:1 is not a recorded CodeAct call of this run
  W3: CONFIRMED_ROOT_CAUSE → HYPOTHESIS: no verified OBSERVED_FACT/CODE_FACT in supports
  root cause CONFIRMED → PROBABLE → UNCONFIRMED
confirmed_facts []
```

**Mutation check.** With CodeAct references ignored by provenance, the correct-diagnosis and wrong-diagnosis tests
both fail.

## Limitations

- Stages A–D are one agent step, so the platform cannot checkpoint between collection and diagnosis; a retry re-runs
  the whole step (CodeAct evidence of the earlier attempt stays recorded).
- `observed` checks cover JSON-pointer equality, list counts and inclusion on the recorded (redacted, ≤24k-char)
  result; derived aggregates computed inside a program are checkable only if the program returned them in a nested
  call's recorded result — a program's own return value is never evidence.
- Live-provider investigation quality is NOT VERIFIED; no real SigNoz/Splunk data was used.
