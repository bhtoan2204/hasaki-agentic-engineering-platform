import { createHash } from "node:crypto";
import { knowledge } from "./service.ts";
import { createProposal, approveProposal } from "./proposals.ts";
import { auditKnowledge, type AuditInput, type AuditItem } from "./audit.ts";

export const AUDIT_ACTOR = "system:knowledge-audit";
export async function remediateKnowledgeAudit(
  input: AuditInput,
  options: { autoApply?: boolean } = {},
) {
  const report = auditKnowledge(input);
  const results: Array<{ key: string; proposalId: number; status: string }> = [];
  const shared = new Map(
    input.items.filter((i) => i.owner_id == null && i.id != null).map((i) => [i.key, i]),
  );
  for (const finding of report.findings) {
    const targets = finding.kind === "exact_duplicate" ? finding.keys.slice(1) : finding.keys;
    for (const key of targets) {
      const item = shared.get(key);
      if (!item) continue;
      const current = await knowledge.get(key);
      if (!current || !current.enabled || current.current_version !== item.current_version)
        continue;
      const canonical: AuditItem | undefined = shared.get(finding.keys[0]);
      const { proposal } = await createProposal({
        ownerId: null,
        changeType: "DEPRECATE",
        targetKey: key,
        proposed:
          finding.kind === "exact_duplicate" && canonical
            ? {
                superseded_by: canonical.key,
                canonical_version: canonical.current_version,
                canonical_sha256: createHash("sha256").update(canonical.content).digest("hex"),
              }
            : {},
        createdBy: AUDIT_ACTOR,
        auditReviewOnly: true,
        sourceKind: "manual",
        confidence: finding.classification === "verified" ? 1 : 0.5,
        uncertainty: finding.autoApply ? "" : "Admin review required; no automatic change",
        impacts: {
          audit_kind: finding.kind,
          proposed_action: finding.action,
          automatic: finding.autoApply,
        },
        evidence: [
          {
            source: "knowledge_audit",
            ref: { keys: finding.keys, window_days: input.windowDays ?? 7 },
            author: AUDIT_ACTOR,
            trust: "platform",
            quote: finding.detail,
          },
        ],
      });
      if (!proposal) continue;
      if (options.autoApply && finding.autoApply && proposal.status === "pending")
        await approveProposal(proposal.id, { by: AUDIT_ACTOR });
      results.push({
        key,
        proposalId: proposal.id,
        status: options.autoApply && finding.autoApply ? "approved" : proposal.status,
      });
    }
  }
  return { report, proposals: results };
}
