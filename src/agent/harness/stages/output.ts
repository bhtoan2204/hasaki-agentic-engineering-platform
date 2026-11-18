import type { ExecResult } from "../../../workflow/types.ts";
import type { LifecycleState } from "../state.ts";
import { workspacesOf } from "../../../git/provider.ts";
import { missingContractKeys, validateOutputContract } from "../../contract.ts";
import { evidenceRole, normalizeInvestigationOutput, unavailableSources } from "../../evidence.ts";
import { runProvenanceEnv, withProvenance } from "../../provenance.ts";

/** Output contract validation of the submitted result, coding outcome normalization and investigation evidence normalization. */
export async function outputStage(s: LifecycleState): Promise<ExecResult | void> {
  const { ctx, mode, provider, independent, submitted, result, metrics } = s;
  const pName =
    provider === "codex"
      ? "Codex"
      : provider === "copilot"
        ? "Copilot"
        : provider === "cursor"
          ? "Cursor"
          : provider === "antigravity"
            ? "Antigravity"
            : provider === "claude"
              ? "Claude"
              : String(provider);
  if (!independent) {
    if (ctx.step.config?.output_schema || ctx.step.config?.output_contract) {
      if (!submitted)
        return {
          kind: "failed",
          error: `${pName} finished the turn without calling submit_result; no step output was recorded.`,
          retryable: true,
        };
      const missing = missingContractKeys(ctx.step.config.output_contract, submitted);
      if (missing.length)
        return {
          kind: "failed",
          error: `${pName} submitted an output that does not match the step's output contract (missing: ${missing.join(", ")}).`,
          retryable: true,
          details: { submitted },
        };
      const validation = validateOutputContract(
        ctx.step.config.output_schema ?? ctx.step.config.output_contract,
        submitted,
      );
      if (!validation.valid)
        return {
          kind: "failed",
          error: `${pName} submitted an output that does not match the step's output contract:
  ${validation.errors.join("; ")}`,
          retryable: true,
          details: { submitted, errors: validation.errors },
        };
    }
  }
  const terminalCodingFailure = (
    candidate: Record<string, unknown> | undefined,
  ): ExecResult | null => {
    if (mode !== "coding" || independent) return null;
    const outcome =
      candidate?.outcome === "FAILED"
        ? "FAILED"
        : candidate?.outcome === "BLOCKED" || candidate?.blocked === true
          ? "BLOCKED"
          : null;
    return outcome
      ? {
          kind: "failed",
          retryable: false,
          error: `Coding outcome ${outcome} cannot complete successfully`,
          details: { submitted: candidate },
        }
      : null;
  };
  const terminalSubmission = terminalCodingFailure(submitted);
  if (terminalSubmission) return terminalSubmission;
  let output: Record<string, unknown> = submitted ?? { summary: result.text };
  if (mode === "coding" && !independent) {
    if (submitted?.outcome === "NO_CHANGE_REQUIRED" || submitted?.no_change_required === true) {
      output.outcome = "NO_CHANGE_REQUIRED";
    } else if (submitted?.outcome === "BLOCKED" || submitted?.blocked === true) {
      output.outcome = "BLOCKED";
    } else if (submitted?.outcome === "FAILED") {
      output.outcome = "FAILED";
    } else {
      output.outcome = "IMPLEMENTED";
    }
  }
  // A coding step that produced nothing — no submitted result AND no workspace — is blocked, not done (e.g. the
  // branch it must continue from does not exist). Completing it would send an empty diff to review and burn repair
  // rounds; a legitimate "no change needed" outcome is reported through submit_result.
  if (
    mode === "coding" &&
    !independent &&
    !submitted &&
    !(await workspacesOf(ctx.run.id).catch(() => [])).length
  )
    return {
      kind: "failed",
      error: `coding step ended without a submitted result and without a workspace (no code was changed): ${String(
        result.text ?? "",
      )
        .replace(/\s+/g, " ")
        .slice(0, 600)}`,
      retryable: false,
    };

  // Evidence-gated investigation: normalize claims/root cause/fix risk (only ever lowers certainty, notes every change).
  const role = independent ? null : evidenceRole(ctx.step.config);
  if (role) {
    // Platform provenance first (repo/commit/file/lines/staleness, this run's tool calls and artifacts): it may only
    // lower a claim's status, so the root-cause caps and the evidence gate below never rest on fake or stale citations.
    if (Array.isArray((output as any).claims))
      output = {
        ...output,
        claims: await withProvenance(
          (output as any).claims,
          await runProvenanceEnv(ctx.run as any),
        ),
      };
    output = normalizeInvestigationOutput(
      role,
      output,
      Object.fromEntries(Object.entries(ctx.input.upstream).map(([k, u]) => [k, u.output])),
      unavailableSources(ctx.context.contextPack),
    );
    const ev = output as any;
    metrics.evidence = {
      role,
      claims: ev.claims?.length ?? 0,
      downgraded: ev.evidence_validation?.downgraded ?? 0,
      missing_evidence: ev.missing_evidence?.length ?? 0,
      root_cause_status: ev.root_cause_assessment?.status ?? null,
      fix_risk: ev.fix_assessment?.risk ?? null,
      gate_satisfied: ev.evidence_gate?.satisfied ?? null,
    };
    await ctx.recordMetrics(metrics as unknown as Record<string, unknown>).catch(() => {});
  }
  Object.assign(s, { output, terminalCodingFailure });
}
