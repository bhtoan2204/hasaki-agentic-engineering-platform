# CodeAct P2 — Real Integration Investigation

**Status: IMPLEMENTED — REAL INTEGRATION NOT VERIFIED**

No real SigNoz/Splunk investigation was executed. No integration response was invented, and no fixture result is
labeled as real.

## Blockers

1. **Provider spend not authorized.** A real investigation runs the `incident-investigation` workflow, whose
   `investigate` step is a live model agent. The task forbids paid runs without an explicitly authorized budget, and
   earlier pilot budgets do not count.
2. **Integration access is per user.** SigNoz and Splunk credentials live encrypted per user in the database
   (Integrations page). They are used only by the platform inside that user's runs. This work does not decrypt them,
   copy them to `.env`, or call the integrations outside the platform.
3. **No chosen incident.** A non-sensitive OMS/Payment incident with enough observability (a time window and the
   services involved) has to be named by the user.

## What is ready (verified at Levels 1–3)

- **Workflow template `incident-investigation`:** discover → investigate (evidence role `root_cause`) → verify & report.
  The report step now enforces objectives (trace, log, code; a CONFIRMED root cause supported by checked
  observations). See the P0 report.
- **CodeAct:**
  - Sanitized failure diagnostics, recovery accounting and composition of read-only platform reads.
  - Durable evidence refs that resolve only within the run.
  - Nested calls run in the OS sandbox (Milestones A–D, M1–M4).
- **Provenance:** checks codeact, tool-call, artifact and code-location citations against this run's records, and
  records the source tool from the record.
- **No production writes:** CodeAct is read-only, the report step changes nothing, and remediation goes through the
  approved coding workflow.

## Procedure once authorized

1. **The user picks an incident**, for example refund timeouts at payment-gateway in a known 30-minute window. The
   user confirms that their SigNoz/Splunk integrations are connected (Integrations page) and the repositories in
   scope.
2. **Start the workflow on the running platform** (not the shared RDS from a test harness): create a work item
   describing the symptom and time window, and start `incident-investigation` with
   `CODEACT_ENABLED=1` and a pinned model (e.g. `claude-sonnet-5-5`, effort medium).
3. **Collect evidence afterwards, read-only:**
   - the run id;
   - `code_executions` and `code_execution_calls` (ids, tools, statuses, diagnostics; **no payloads**);
   - tool-call counts;
   - the report step's `verification` (status, sufficiency, failures);
   - source locations and commits;
   - root-cause candidates and missing evidence;
   - `provider_models`, tokens, cost and latency from the attempt metrics.
4. **Inspect** that every cited `codeact:` and `tool_call:` ref resolves to this run, that the observations hold, and
   that the verdict matches the evidence. Record sanitized ids and refs only.

Expected cost: one investigation is roughly 10–30 model turns, on the order of $0.5–2 at pilot-2 prices. It needs
explicit approval.
