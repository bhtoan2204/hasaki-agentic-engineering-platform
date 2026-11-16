import { createHash } from "node:crypto";
import { knowledge } from "./service.ts";
import { createProposal, approveProposal, AUDIT_ACTOR } from "./proposals.ts";
import { auditKnowledge, type AuditInput, type AuditItem } from "./audit.ts";

export { AUDIT_ACTOR };
const PROTECTED = new Set(["business_rule", "security_policy"]);
export async function remediateKnowledgeAudit(
  input: AuditInput,
  options: { autoApply?: boolean; dryRun?: boolean; operator?: string } = {},
) {
  const report = auditKnowledge(input);
  const results: Array<{
    key: string;
    kind: string;
    proposalId?: number;
    status: string;
    reason?: string;
  }> = [];
  const shared = new Map(
    input.items.filter((i) => i.owner_id == null && i.id != null).map((i) => [i.key, i]),
  );
  for (const finding of report.findings) {
    // Every other finding is report-only: absence of use, overlap or size is no reason to disable an item.
    const targets =
      finding.kind === "exact_duplicate"
        ? finding.keys.slice(1)
        : finding.kind === "outdated"
          ? finding.keys
          : [];
    for (const key of targets) {
      const item = shared.get(key);
      if (!item) continue;
      if (item.enforced || PROTECTED.has(item.category)) {
        results.push({ key, kind: finding.kind, status: "skipped", reason: "protected category" });
        continue;
      }
      const current = await knowledge.get(key);
      if (!current || !current.enabled || current.current_version !== item.current_version)
        continue;
      if (options.dryRun) {
        results.push({ key, kind: finding.kind, status: "planned" });
        continue;
      }
      const canonical: AuditItem | undefined = shared.get(finding.keys[0]);
      let proposalId: number | undefined;
      try {
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
              ref: {
                keys: finding.keys,
                window_days: input.windowDays ?? 7,
                operator: options.operator ?? null,
              },
              author: AUDIT_ACTOR,
              trust: "platform",
              quote: finding.detail,
            },
          ],
        });
        if (!proposal) continue;
        proposalId = proposal.id;
        const final =
          options.autoApply && finding.autoApply && proposal.status === "pending"
            ? await approveProposal(proposal.id, { by: AUDIT_ACTOR })
            : proposal;
        results.push({ key, kind: finding.kind, proposalId: proposal.id, status: final.status });
      } catch (e) {
        results.push({
          key,
          kind: finding.kind,
          proposalId,
          status: "skipped",
          reason: (e as Error).message,
        });
      }
    }
  }
  return { report, proposals: results };
}
