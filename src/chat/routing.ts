import type { ChatMode, Mention } from "./types.ts";
import { MODE_GROUPS, type ToolGroup } from "./toolGroups.ts";

/**
 * Intent routes (execution strategies). Requested conversation mode stays independent; AUTO resolves
 * to one of these per turn. Tool allowlists still come from the effective mode, never from the model.
 */
export const CHAT_ROUTES = [
  "DIRECT_ANSWER",
  "KNOWLEDGE_LOOKUP",
  "REPOSITORY_QUERY",
  "PLATFORM_QUERY",
  "OBSERVABILITY_INVESTIGATION",
  "DATABASE_INVESTIGATION",
  "ENGINEERING_PLAN",
  "WORKFLOW_DELEGATION",
  "CLARIFICATION",
] as const;
export type ChatRoute = (typeof CHAT_ROUTES)[number];

export type DecisionSource = "explicit" | "mention" | "deterministic" | "context" | "default";

export interface RoutingDecision {
  requested_mode: ChatMode;
  effective_mode: Exclude<ChatMode, "AUTO">;
  route: ChatRoute;
  /** Legacy fast-path flag used by the tool loop. */
  path: "direct" | "tools";
  reason: string;
  source: DecisionSource;
  confidence: number;
}

/** Explicit non-AUTO modes map directly; AUTO is resolved from signals. */
export function resolveEffectiveMode(requested: ChatMode, route: ChatRoute): Exclude<ChatMode, "AUTO"> {
  if (requested !== "AUTO") return requested;
  switch (route) {
    case "OBSERVABILITY_INVESTIGATION":
    case "DATABASE_INVESTIGATION":
      return "INVESTIGATE";
    case "ENGINEERING_PLAN":
      return "PLAN";
    case "WORKFLOW_DELEGATION":
      return "DELEGATE";
    default:
      return "ASK";
  }
}

export function toolGroupsFor(mode: Exclude<ChatMode, "AUTO">): ToolGroup[] {
  return MODE_GROUPS[mode];
}

// --- layered signals (deterministic; no paid model call) ---

const OBS =
  /\b(splunk|signoz|trace|traces|span|latency|log|logs|error rate|incident|prod(?:uction)?\s*error|outage|p99|apm)\b|nhật ký|sự cố|lỗi production|theo dõi/i;
const DB =
  /\b(sql|select\b|database|schema|table|query|postgres|mysql|information_schema)\b|cơ sở dữ liệu|truy vấn|bảng dữ liệu/i;
const PLATFORM =
  /\b(work\s*item|workflow|run\b|task\b|approval|delegation|investigation|ticket|REQ-\d+)\b|work item|lượt chạy|công việc|tiến độ|chạy tới đâu|task hồi/i;
const REPO =
  /\b(repo|repository|source|code|implement(?:ation)?|service|module|class|function|file|endpoint|api|provider|integration|gateway|payment|refund|checkout|inventory)\b|mã nguồn|tích hợp|cổng thanh toán|hoàn tiền|provider thanh toán|bao nhiêu|đang có|bên mình|workspace|hasaki/i;
const KNOWLEDGE =
  /\b(convention|runbook|playbook|knowledge|policy|guideline|how do we|standard)\b|quy ước|kiến thức|tài liệu nội bộ/i;
const PLAN =
  /\b(plan|roadmap|approach|design|architecture|estimate|break(?:\s|-)?down)\b|kế hoạch|thiết kế|phương án|ước lượng/i;
const DELEGATE =
  /\b(implement|fix|build|create pr|open pr|ship|deploy|refactor|migrate)\b|làm giúp|sửa giúp|triển khai|mở pr|viết code|uỷ thác|ủy thác/i;
const GENERIC_TECH =
  /^(what is|what's|explain|define|why (?:do|does|is)|how does)\b|^[^.?]{0,80}\?$/i;

const OPS =
  /\b(kafka|topic|publish|produce|consumer group|argo ?cd|vault|jira|pod)\b|bắn event|đẩy event|gửi event|tạo đơn|bảo hành|tạo order|warranty/i;

function score(re: RegExp, text: string, weight: number) {
  return re.test(text) ? weight : 0;
}

/**
 * Lightweight contextual intent routing.
 * Order: explicit mode → mentions → deterministic multi-signal scoring → safe default.
 * Does not invent workspace facts; REPOSITORY/PLATFORM/OBSERVABILITY routes open the tool loop.
 */
export function routeChatIntent(input: {
  mode: ChatMode;
  message: string;
  mentions: Mention[];
  priorRoute?: string | null;
}): RoutingDecision {
  const text = input.message.trim();
  const mentions = input.mentions.filter((m) => m.resolved);

  if (input.mode === "INVESTIGATE")
    return decide("INVESTIGATE", obsOrDb(text), "explicit mode INVESTIGATE", "explicit", 1);
  if (input.mode === "PLAN")
    return decide("PLAN", "ENGINEERING_PLAN", "explicit mode PLAN", "explicit", 1);
  if (input.mode === "DELEGATE")
    return decide("DELEGATE", "WORKFLOW_DELEGATION", "explicit mode DELEGATE", "explicit", 1);

  if (mentions.some((m) => m.kind === "run" || m.kind === "task"))
    return decide(
      input.mode === "AUTO" ? "ASK" : (input.mode as Exclude<ChatMode, "AUTO">),
      "PLATFORM_QUERY",
      "resolved @task/@run mention",
      "mention",
      0.95,
    );
  if (mentions.some((m) => m.kind === "repo" || m.kind === "file"))
    return decide(
      input.mode === "AUTO" ? "ASK" : (input.mode as Exclude<ChatMode, "AUTO">),
      "REPOSITORY_QUERY",
      "resolved @repo/@file mention",
      "mention",
      0.95,
    );
  if (mentions.some((m) => m.kind === "knowledge"))
    return decide(
      input.mode === "AUTO" ? "ASK" : (input.mode as Exclude<ChatMode, "AUTO">),
      "KNOWLEDGE_LOOKUP",
      "resolved @knowledge mention",
      "mention",
      0.9,
    );

  // ASK or AUTO: multi-signal scoring (not a single growing keyword OR).
  const s = {
    obs: score(OBS, text, 4),
    db: score(DB, text, 4),
    platform: score(PLATFORM, text, 3),
    repo: score(REPO, text, 3),
    knowledge: score(KNOWLEDGE, text, 2),
    plan: score(PLAN, text, 3),
    delegate: score(DELEGATE, text, 3),
  };

  // Inventory / "how many X in our workspace" → repository/platform tools even without "code" words.
  if (
    /(bao nhiêu|how many|which|những|các)\b/.test(text) &&
    /(provider|cổng|payment|thanh toán|service|integration|tích hợp)/i.test(text)
  ) {
    return decide(
      "ASK",
      "REPOSITORY_QUERY",
      "workspace inventory question",
      "deterministic",
      0.85,
    );
  }

  if (score(OPS, text, 4) >= 4)
    return decide(
      input.mode === "AUTO" ? "INVESTIGATE" : "ASK",
      "PLATFORM_QUERY",
      "integration/operation signals",
      "deterministic",
      0.8,
    );
  if (s.delegate >= 3 && input.mode === "AUTO")
    return decide("DELEGATE", "WORKFLOW_DELEGATION", "implementation request", "deterministic", 0.8);
  if (s.plan >= 3 && (input.mode === "AUTO" || input.mode === "ASK"))
    return decide(
      input.mode === "AUTO" ? "PLAN" : "ASK",
      "ENGINEERING_PLAN",
      "planning request",
      "deterministic",
      0.75,
    );
  if (s.obs >= 4)
    return decide(
      input.mode === "AUTO" ? "INVESTIGATE" : ((input.mode === "ASK" ? "ASK" : input.mode) as Exclude<ChatMode, "AUTO">),
      input.mode === "ASK" ? "PLATFORM_QUERY" : "OBSERVABILITY_INVESTIGATION",
      "observability signals",
      "deterministic",
      0.85,
    );
  if (s.db >= 4)
    return decide(
      input.mode === "AUTO" ? "INVESTIGATE" : "ASK",
      input.mode === "AUTO" ? "DATABASE_INVESTIGATION" : "PLATFORM_QUERY",
      "database signals",
      "deterministic",
      0.8,
    );
  if (s.platform >= 3)
    return decide("ASK", "PLATFORM_QUERY", "platform/work-item signals", "deterministic", 0.8);
  if (s.repo >= 3)
    return decide("ASK", "REPOSITORY_QUERY", "repository/workspace signals", "deterministic", 0.8);
  if (s.knowledge >= 2)
    return decide("ASK", "KNOWLEDGE_LOOKUP", "knowledge signals", "deterministic", 0.7);

  // Follow-up continuity: short referential messages reuse prior tool route.
  if (
    input.priorRoute &&
    input.priorRoute !== "DIRECT_ANSWER" &&
    /^(còn|còn lại|thế còn|vậy|và|also|what about|how about)\b/i.test(text) &&
    text.length < 120
  ) {
    return decide(
      "ASK",
      (CHAT_ROUTES.includes(input.priorRoute as ChatRoute)
        ? input.priorRoute
        : "REPOSITORY_QUERY") as ChatRoute,
      "follow-up reuses prior route",
      "context",
      0.7,
    );
  }

  if (input.mode === "ASK" || input.mode === "AUTO") {
    if (GENERIC_TECH.test(text) && s.repo === 0 && s.platform === 0)
      return decide("ASK", "DIRECT_ANSWER", "generic technical question", "deterministic", 0.9);
    if (text.length < 180 && !/[`/\\]/.test(text) && s.repo === 0 && s.platform === 0 && s.obs === 0)
      return decide("ASK", "DIRECT_ANSWER", "short general question", "default", 0.65);
  }

  // Low confidence: prefer bounded tools over inventing workspace facts.
  if (input.mode === "AUTO")
    return decide("ASK", "REPOSITORY_QUERY", "AUTO default: bounded workspace lookup", "default", 0.4);
  return decide("ASK", "DIRECT_ANSWER", "ASK default: direct answer", "default", 0.5);
}

function obsOrDb(text: string): ChatRoute {
  if (DB.test(text) && !OBS.test(text)) return "DATABASE_INVESTIGATION";
  return "OBSERVABILITY_INVESTIGATION";
}

function decide(
  effective: Exclude<ChatMode, "AUTO">,
  route: ChatRoute,
  reason: string,
  source: DecisionSource,
  confidence: number,
): RoutingDecision {
  return {
    requested_mode: effective, // caller overwrites requested_mode
    effective_mode: effective,
    route,
    path: route === "DIRECT_ANSWER" ? "direct" : "tools",
    reason,
    source,
    confidence,
  };
}

/** Public entry: preserves the requested mode on the decision object. */
export function routeTurnIntelligent(
  mode: ChatMode,
  message: string,
  mentions: Mention[],
  priorRoute?: string | null,
): RoutingDecision {
  const d = routeChatIntent({ mode, message, mentions, priorRoute });
  return { ...d, requested_mode: mode, effective_mode: resolveEffectiveMode(mode, d.route) };
}
