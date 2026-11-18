import { z } from "zod";
import { HttpError } from "../http/error.ts";
import { hashOf, definitions } from "../workflow/definitions.ts";
import { previewRun, startRun } from "../workflow/engine.ts";
import { routeWorkflow } from "../investigation/service.ts";
import { workItems } from "../workitems/service.ts";
import { loadAgentConfiguration } from "../agent/configurationStore.ts";
import { parseAgentProvider } from "../agent/provider.ts";
import { audit } from "../authz/access.ts";
import { chatRepository } from "./repository.ts";
import { emitChatEvent } from "./events.ts";
import { readableRepositories } from "./tools.ts";
import { withholdRevoked } from "./runtime.ts";
import type { ConversationRow, MessageRow, ToolCallRow } from "./types.ts";

/**
 * Chat → workflow delegation. The preview is a pure function of the conversation and the request; execution
 * recomputes it and requires the same hash plus an explicit confirmation, so what the user authorized is what runs.
 * Execution reuses the ordinary work-item and run services (repository authorization, profile selection, frozen
 * agent configuration). The delegated context is marked chat-derived and unverified: it never satisfies a workflow
 * verification gate, which only accepts the workflow's own evidence.
 */
export const DelegationRequest = z
  .object({
    message_id: z.number().int().positive().optional(),
    workflow: z
      .string()
      .regex(/^[a-z0-9_-]+$/)
      .max(80)
      .optional(),
    title: z.string().min(3).max(200).optional(),
    repositories: z.array(z.string().min(1).max(200)).max(20).optional(),
    kind: z.enum(["task", "investigation", "plan", "delegate"]).optional(),
  })
  .strict();
export type DelegationRequest = z.infer<typeof DelegationRequest>;

const STALE_MS = 24 * 3600_000;

const KIND_WORKFLOW: Record<string, string[]> = {
  investigation: ["bug-investigation", "production-investigation", "investigation"],
  plan: ["feature-planning", "planning", "plan"],
};

export function acceptanceCriteria(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) =>
    /^\s*(#{1,6}\s*|\*\*)?\s*(acceptance criteria|tiêu chí (chấp nhận|nghiệm thu|hoàn thành))/i.test(
      l,
    ),
  );
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\s*#{1,6}\s/.test(l) || (/^\s*\*\*.+\*\*\s*$/.test(l) && out.length)) break;
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ x]\]\s*)?(.+)$/.exec(l);
    if (m) out.push(m[1].trim().slice(0, 300));
    if (out.length >= 15) break;
  }
  return out;
}

export function assessRisk(text: string, repositories: string[]) {
  const reasons: string[] = [];
  if (repositories.length > 2) reasons.push(`${repositories.length} repositories`);
  const hits = text.match(
    /\b(payment|checkout|migration|schema|database|security|auth\w*|permission|production|prod|delete|refund|price|inventory)\b|thanh toán|bảo mật|phân quyền|xoá|xóa|hoàn tiền|tồn kho/gi,
  );
  const terms = [...new Set((hits ?? []).map((h) => h.toLowerCase()))].slice(0, 6);
  if (terms.length) reasons.push(`sensitive areas: ${terms.join(", ")}`);
  const level =
    terms.length >= 3 || repositories.length > 3
      ? "high"
      : terms.length || repositories.length > 1
        ? "medium"
        : "low";
  return { level, reasons };
}

function sourceMessage(messages: MessageRow[], id?: number) {
  if (id) {
    const m = messages.find((x) => x.id === id);
    if (!m) throw new HttpError(404, "message not found in this conversation");
    return m;
  }
  return (
    [...messages].reverse().find((m) => m.role === "assistant") ??
    [...messages].reverse().find((m) => m.role === "user")
  );
}

function evidenceOf(calls: ToolCallRow[], readable: string[], now: number) {
  return calls
    .filter((c) => c.status === "ok" && c.evidence_ref)
    .filter((c) => c.repositories.every((r) => readable.includes(r)))
    .slice(-20)
    .map((c) => ({
      tool_call_id: c.id,
      tool: c.tool,
      ref: c.evidence_ref!,
      repositories: c.repositories,
      collected_at: c.created_at,
      stale: now - new Date(c.created_at).getTime() > STALE_MS,
    }));
}

export async function buildDelegationPreview(
  conversation: ConversationRow,
  request: DelegationRequest,
) {
  const ownerId = conversation.owner_id;
  const readable = await readableRepositories(ownerId);
  const messages = withholdRevoked(
    (await chatRepository.historyFor(conversation.id, 0)).filter((m) => m.role !== "system"),
    readable,
  ).filter((m) => !m.withheld);
  const source = sourceMessage(messages, request.message_id);
  if (!source) throw new HttpError(400, "the conversation has no message to delegate");
  const userAsks = messages.filter((m) => m.role === "user").slice(-3);
  const repositories = request.repositories ?? conversation.repositories;
  const outside = repositories.filter((r) => !readable.includes(r));
  if (outside.length)
    throw new HttpError(403, `repositories not found or not accessible: ${outside.join(", ")}`);

  const now = Date.now();
  const evidence = evidenceOf(await chatRepository.toolCallsOf(conversation.id), readable, now);
  const firstLine = (s: string) =>
    s
      .split("\n")
      .map((l) => l.replace(/^#+\s*/, "").trim())
      .find(Boolean) ?? "";
  const title = (
    request.title ??
    (conversation.title || firstLine(userAsks.at(-1)?.content ?? source.content))
  ).slice(0, 200);
  const excerpts = [
    ...userAsks.map((m) => ({ message_id: m.id, role: m.role, excerpt: m.content.slice(0, 600) })),
    ...(source.role === "assistant"
      ? [{ message_id: source.id, role: source.role, excerpt: source.content.slice(0, 6000) }]
      : []),
  ];
  const criteria = acceptanceCriteria(source.content);
  const description = [
    `## Context from chat conversation #${conversation.id}`,
    "> Chat-derived and unverified. The workflow must collect and verify its own evidence; chat conclusions are not verification results.",
    "",
    source.role === "assistant" ? source.content.slice(0, 6000) : "",
    "",
    "## Requests in the conversation",
    ...userAsks.map((m) => `- ${m.content.replace(/\s+/g, " ").slice(0, 400)}`),
    ...(criteria.length ? ["", "## Acceptance criteria", ...criteria.map((c) => `- ${c}`)] : []),
    ...(evidence.length
      ? [
          "",
          "## Chat evidence references (re-verify)",
          ...evidence.map(
            (e) =>
              `- ${e.tool} ${e.ref} at ${new Date(e.collected_at).toISOString()}${e.stale ? " (stale)" : ""}`,
          ),
        ]
      : []),
  ]
    .join("\n")
    .trim();

  const defs = await definitions.list(undefined, { ownerId });
  const published = defs.filter((d) => !d.archived && d.latest_version);
  const candidates = KIND_WORKFLOW[request.kind ?? ""] ?? [];
  const routed = routeWorkflow(`${title}\n${userAsks.map((m) => m.content).join("\n")}`, published);
  const workflowKey =
    request.workflow ??
    candidates.find((k) => published.some((d) => d.key === k)) ??
    routed.workflow ??
    null;
  const workflow = workflowKey ? published.find((d) => d.key === workflowKey) : null;
  if (request.workflow && !workflow)
    throw new HttpError(404, `workflow "${request.workflow}" not found`);

  const cfg = await loadAgentConfiguration();
  const provider = parseAgentProvider(conversation.provider) ?? cfg.default_provider;
  const warnings: string[] = [];
  if (!cfg.providers[provider]?.enabled)
    warnings.push(`provider ${provider} is disabled; the run would be refused`);
  if (!workflow) warnings.push("no workflow matched: choose one before delegating");
  if (!repositories.length)
    warnings.push("no repository selected: the workflow will discover repositories itself");
  if (evidence.some((e) => e.stale))
    warnings.push("some evidence is older than 24 h and marked stale");

  let profile: unknown = null;
  let steps: number | null = null;
  if (workflow)
    try {
      const p = await previewRun({
        definitionKey: workflow.key,
        title,
        inputs: { request: description },
        repositories,
        ownerId,
      });
      profile = p.profile;
      steps = p.graph.steps.length;
    } catch (e) {
      warnings.push(`workflow preview: ${(e as Error).message}`);
    }

  const pkg = {
    conversation_id: conversation.id,
    source_message_id: source.id,
    title,
    description,
    acceptance_criteria: criteria,
    repositories,
    risk: assessRisk(`${title}\n${description}`, repositories),
    workflow: workflow ? { key: workflow.key, name: workflow.name, steps } : null,
    workflow_matches: routed.matches
      .slice(0, 5)
      .map((m) => ({ key: m.key, name: m.name, score: m.score })),
    profile,
    agent: { provider, model: conversation.model, reasoning_effort: conversation.reasoning_effort },
    excerpts,
    evidence,
    warnings,
  };
  return { ...pkg, hash: hashOf(pkg) };
}

export async function executeDelegation(
  conversation: ConversationRow,
  request: DelegationRequest,
  confirm: { hash: string; confirmed: boolean },
) {
  if (confirm.confirmed !== true)
    throw new HttpError(400, "delegation requires explicit confirmation");
  const existing = await chatRepository.delegationByHash(conversation.id, confirm.hash);
  if (existing) return { ...existing, duplicate: true };
  const pkg = await buildDelegationPreview(conversation, request);
  if (pkg.hash !== confirm.hash)
    throw new HttpError(
      409,
      "the delegation preview changed (new messages, evidence or permissions); review it again",
    );
  if (!pkg.workflow) throw new HttpError(400, "choose a workflow before delegating");
  const ownerId = conversation.owner_id;
  const item = await workItems.createManual({
    title: pkg.title,
    description: pkg.description,
    ownerId,
  });
  await chatRepository.setWorkItemChatPayload(item.id, ownerId, {
    acceptance_criteria: pkg.acceptance_criteria,
    chat_delegation: {
      conversation_id: conversation.id,
      preview_hash: pkg.hash,
      source_message_id: pkg.source_message_id,
      evidence: pkg.evidence,
      provenance: "chat",
      verified: false,
    },
  });
  let runId: number | null = null;
  let runError: string | null = null;
  try {
    const run = await startRun({
      definitionKey: pkg.workflow.key,
      workItemId: item.id,
      title: pkg.title,
      inputs: { request: pkg.description, chat_conversation_id: conversation.id },
      repositories: pkg.repositories,
      agentProvider: pkg.agent.provider,
      ownerId,
    });
    runId = Number((run as { id: number }).id);
  } catch (e) {
    runError = String((e as Error).message ?? e).slice(0, 500);
  }
  const row = await chatRepository.recordDelegation({
    conversationId: conversation.id,
    ownerId,
    hash: pkg.hash,
    workItemId: item.id,
    runId,
    package: pkg,
  });
  await audit(ownerId, "chat.delegate", "chat_conversation", String(conversation.id), {
    work_item_id: item.id,
    run_id: runId,
    workflow: pkg.workflow.key,
    repositories: pkg.repositories,
    run_error: runError,
  });
  await emitChatEvent({
    conversationId: conversation.id,
    ownerId,
    turnId: null,
    kind: "conversation.updated",
    data: { work_item_id: item.id, run_id: runId, delegation_id: row?.id ?? null },
  });
  return { ...row, work_item_code: item.code, run_error: runError, duplicate: false };
}
