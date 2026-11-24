import { config } from "../config.ts";
import { q, pool } from "../db/pool.ts";

/** Code-intelligence tools whose recorded result can ground a finding in the indexed code. */
export const CODE_INTELLIGENCE_TOOLS = [
  "platform.search_code",
  "platform.get_symbol",
  "platform.find_dependencies",
  "platform.navigate_code",
];

export interface CodeCall {
  id: number;
  tool: string;
  text: string;
}
export type CodeEvidence =
  { status: "verified"; calls: number[] } | { status: "missing"; reason: string };

const normalizedFile = (file: string) => file.trim().replace(/^\.\//, "").replace(/^\/+/, "");

/**
 * A finding is grounded when one of the agent's own code-intelligence calls returned its file: the platform recorded
 * that result, so the location exists in the index, not only in the agent's narration. Findings without a file cannot
 * be grounded.
 */
export function groundFindings<F extends { file?: unknown }>(
  findings: F[],
  calls: CodeCall[],
): Array<F & { code_evidence: CodeEvidence }> {
  return findings.map((f) => {
    const file = typeof f.file === "string" ? normalizedFile(f.file) : "";
    if (!file)
      return { ...f, code_evidence: { status: "missing", reason: "the finding names no file" } };
    const hits = calls.filter((c) => c.text.includes(file)).map((c) => c.id);
    return {
      ...f,
      code_evidence: hits.length
        ? { status: "verified", calls: hits.slice(0, 5) }
        : {
            status: "missing",
            reason: calls.length
              ? `no code-intelligence result of this attempt shows ${file}`
              : "the agent made no code-intelligence call (search_code, get_symbol, find_dependencies, navigate_code)",
          },
    };
  });
}

/**
 * The agent's own successful code-intelligence calls in one attempt. Calls the platform made while preparing the
 * context come before the agent's first prompt and do not count: they show what was retrieved, not what was checked.
 */
export async function agentCodeCalls(attemptId: number): Promise<CodeCall[]> {
  return q<CodeCall>(
    pool,
    `SELECT c.id, c.tool, c.evidence::text AS text FROM agent_context_tool_calls c
      WHERE c.attempt_id = $1 AND c.status = 'ok' AND c.tool = ANY($2)
        AND c.created_at >= COALESCE((SELECT min(e.created_at) FROM workflow_events e
                                       WHERE e.attempt_id = $1 AND e.kind IN ('prompt', 'system_prompt')), '-infinity')
      ORDER BY c.id`,
    [attemptId, CODE_INTELLIGENCE_TOOLS],
  );
}

/**
 * config.code_evidence = "required": ground every finding; a selected finding that is not grounded cannot go on to a
 * change (decision IMPROVE becomes UNVERIFIED, which the downstream steps do not run on).
 */
export async function requireCodeEvidence(
  output: Record<string, unknown>,
  attemptId: number,
): Promise<Record<string, unknown>> {
  const findings = Array.isArray(output.findings)
    ? (output.findings as Array<{ id?: unknown; file?: unknown }>)
    : [];
  const grounded = groundFindings(findings, await agentCodeCalls(attemptId)).map((f) =>
    f.code_evidence.status === "missing" && !config.codeIntelligence.enabled
      ? {
          ...f,
          code_evidence: {
            status: "missing" as const,
            reason: "code intelligence is disabled on this worker: no finding can be confirmed",
          },
        }
      : f,
  );
  const out: Record<string, unknown> = {
    ...output,
    findings: grounded,
    code_evidence: {
      verified: grounded.filter((f) => f.code_evidence.status === "verified").length,
      unverified: grounded.filter((f) => f.code_evidence.status === "missing").length,
    },
  };
  const selected = (output.selected as { finding_id?: unknown } | undefined)?.finding_id;
  const chosen = grounded.find((f) => f.id === selected);
  if (output.decision === "IMPROVE" && chosen?.code_evidence.status !== "verified") {
    out.decision = "UNVERIFIED";
    out.unverified_reason = `the selected finding is not confirmed by code intelligence: ${
      chosen?.code_evidence.status === "missing"
        ? chosen.code_evidence.reason
        : "it is not in the findings"
    }`;
  }
  return out;
}
