import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Copy,
  MessageSquarePlus,
  MessagesSquare,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  RefreshCw,
  Send,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Workflow,
  AlertTriangle,
} from "lucide-react";
import { api, useApi } from "../api.ts";
import { AGENT_PROVIDERS, agentKey, asProvider } from "../agentProvider.tsx";
import { dialog } from "../dialog/index.ts";
import { EmptyState, ErrorBox, Loading, Markdown, SearchInput, act, ago, toast } from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";
import { applyChatEvent, seedFromTurn, type LiveStatus, type LiveTurn, type TraceItem } from "./chatStream.ts";
import { markPending, reconcilePending, type PendingMessage } from "./chatOptimistic.ts";
import "./Chat.css";

type Mode = "AUTO" | "ASK" | "INVESTIGATE" | "PLAN" | "DELEGATE";

type Conversation = {
  id: number;
  title: string;
  title_source?: "none" | "fallback" | "generated" | "manual";
  mode: Mode;
  provider: string | null;
  preferred_provider?: string | null;
  provider_strategy?: "auto" | "manual";
  fallback_enabled?: boolean;
  model: string | null;
  reasoning_effort: string | null;
  repositories: string[];
  work_item_id: number | null;
  run_id: number | null;
  usage: Record<string, unknown>;
  archived: boolean;
  updated_at: string;
  last_message?: string;
  active_turn?: number | null;
};

type DateGroupKey = "today" | "yesterday" | "week" | "older";

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dateGroupKey(iso: string, now = new Date()): DateGroupKey {
  const t = startOfDay(new Date(iso));
  const today = startOfDay(now);
  const day = 86_400_000;
  if (t === today) return "today";
  if (t === today - day) return "yesterday";
  if (t > today - 7 * day) return "week";
  return "older";
}

function groupConversations(rows: Conversation[]) {
  const order: DateGroupKey[] = ["today", "yesterday", "week", "older"];
  const map = new Map<DateGroupKey, Conversation[]>();
  for (const key of order) map.set(key, []);
  for (const row of rows) map.get(dateGroupKey(row.updated_at))!.push(row);
  return order
    .map((key) => ({ key, items: map.get(key)! }))
    .filter((g) => g.items.length > 0);
}

type Message = {
  id: number;
  turn_id: number | null;
  role: "user" | "assistant" | "system";
  content: string;
  citations?: Array<{ label: string; tool?: string; ref: string; repository?: string }>;
  withheld?: boolean;
  created_at: string;
};

type ToolCall = {
  id: number;
  turn_id: number;
  seq: number;
  tool: string;
  status: string;
  duration_ms: number | null;
};

type Turn = {
  id: number;
  status: string;
  mode?: string;
  effective_mode?: string | null;
  route?: string | null;
  provider?: string | null;
  model?: string | null;
  phase?: string | null;
  failure?: {
    code?: string;
    message?: string;
    provider?: string;
    actions?: string[];
    fallback_attempted?: boolean;
  } | null;
  metrics?: Record<string, unknown>;
  started_at?: string | null;
  finished_at?: string | null;
  created_at: string;
  draft?: string;
  trace?: TraceItem[];
  client_message_id?: string;
};

type Operation = {
  id: number;
  turn_id: number | null;
  tool: string;
  arguments: Record<string, unknown>;
  target: Record<string, unknown>;
  status: string;
  auto?: boolean;
  verification?: { verified: boolean; tool: string; match: string } | null;
  result?: unknown;
  error?: string | null;
  expires_at: string;
};

type Memory = { key: string; title: string; enabled: boolean; content: string; metadata?: { memory?: { kind?: string; count?: number } } };

type Detail = {
  conversation: Conversation;
  messages: Message[];
  tool_calls: ToolCall[];
  turns: Turn[];
  active_turn: Turn | null;
  delegations: Array<{ id: number; work_item_id: number | null; run_id: number | null; work_item_code?: string }>;
  operations?: Operation[];
};

type ProviderRow = {
  id: string;
  enabled?: boolean;
  ok?: boolean;
  error?: string;
  quota?: string;
  controls?: { models?: Array<{ slug: string; name?: string; efforts?: string[] }> };
};

const MODES: Mode[] = ["AUTO", "ASK", "INVESTIGATE", "PLAN", "DELEGATE"];

function clientMessageId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

type T = (k: string, p?: Record<string, string | number>) => string;

function Reasoning({ trace, summary, live }: { trace: TraceItem[]; summary: string; live?: boolean }) {
  const { t } = useI18n();
  return (
    <details className={`chat-reasoning${live ? " is-live" : ""}`}>
      <summary>
        {live && <span className="dot" />}
        {summary}
      </summary>
      <div className="chat-reasoning-body">
        {trace.length === 0 && <div className="muted">{t("chat.reasoning.none")}</div>}
        {trace.map((item, i) =>
          item.k === "reasoning" ? (
            <div key={i} className="chat-reasoning-text">
              {item.text}
            </div>
          ) : item.k === "knowledge" ? (
            <div key={i} className="chat-tool" title={item.key}>
              {t("chat.knowledge.item", {
                title: item.title,
                version: item.version,
                how: t(`chat.knowledge.${item.disclosure}`),
              })}
              {item.owner === "own" ? ` · ${t("chat.knowledge.own")}` : ""}
            </div>
          ) : item.k === "activity" ? (
            <div key={i} className="chat-tool">
              {item.label}
            </div>
          ) : (
            <div key={i} className={`chat-tool${["ok", "running"].includes(item.status) ? "" : " is-err"}`}>
              {item.tool} — {item.status}
              {item.ms != null ? ` (${Math.round(item.ms)} ms)` : ""}
            </div>
          ),
        )}
      </div>
    </details>
  );
}

function OperationCard({ op, onDecide }: { op: Operation; onDecide: (id: number, d: "confirm" | "reject") => void }) {
  const { t } = useI18n();
  const target = Object.values(op.target ?? {}).filter(Boolean).join(" / ");
  return (
    <div className={`chat-operation is-${op.status}`} role={op.status === "pending" ? "alert" : undefined}>
      <div className="chat-operation-head">
        <strong>{t("chat.op.title", { id: op.id, tool: op.tool })}</strong>
        <span className="chat-meta-pill">{t(`chat.op.status.${op.status}`)}</span>
      </div>
      {target && <div className="muted">{target}</div>}
      <details>
        <summary>{t("chat.op.payload")}</summary>
        <pre className="chat-operation-json">{JSON.stringify(op.arguments, null, 2)}</pre>
      </details>
      {op.auto && <div className="muted">{t("chat.op.auto")}</div>}
      {op.verification ? (
        <div className={op.verification.verified ? "muted" : "chat-operation-error"}>
          {t(op.verification.verified ? "chat.op.verified" : "chat.op.verifyFailed", {
            match: op.verification.match,
            tool: op.verification.tool,
          })}
        </div>
      ) : (
        op.status === "succeeded" && <div className="muted">{t("chat.op.notVerified")}</div>
      )}
      {op.error && <div className="chat-operation-error">{op.error}</div>}
      {op.status === "pending" && (
        <div className="chat-failure-actions">
          <button className="sm" onClick={() => onDecide(op.id, "confirm")}>
            {t("chat.op.confirm")}
          </button>
          <button className="ghost sm" onClick={() => onDecide(op.id, "reject")}>
            {t("chat.op.reject")}
          </button>
          <span className="muted">{t("chat.op.expires", { at: new Date(op.expires_at).toLocaleTimeString() })}</span>
        </div>
      )}
    </div>
  );
}

function liveLabel(status: LiveStatus, t: T) {
  return status ? t(`chat.status.${status}`) : "";
}

function traceSummary(turn: Turn | undefined, t: T) {
  const steps = (turn?.trace ?? []).filter((i) => i.k !== "reasoning").length;
  const ms =
    turn?.started_at && turn.finished_at ? Date.parse(turn.finished_at) - Date.parse(turn.started_at) : null;
  return t("chat.reasoning.done", { s: ms != null ? Math.max(1, Math.round(ms / 1000)) : "?", n: steps });
}

function phaseLabel(phase: string | null | undefined, t: T) {
  if (!phase) return t("chat.live.thinking");
  const key = `chat.phase.${phase}`;
  const label = t(key);
  return label === key ? phase.replace(/_/g, " ") : label;
}

export function ChatPage({ conversationId }: { conversationId?: number }) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [sideOpen, setSideOpen] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const list = useApi<Conversation[]>(
    `/api/chat/conversations${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`,
  );
  const providers = useApi<ProviderRow[]>("/api/agent-providers");
  const repos = useApi<Array<{ name: string }>>("/api/repositories");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailErr, setDetailErr] = useState("");
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [liveNote, setLiveNote] = useState("");
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const memories = useApi<Memory[]>(memoryOpen ? "/api/chat/memory" : null);
  const [preview, setPreview] = useState<{
    hash: string;
    title: string;
    source_message_id?: number;
    workflow?: { key: string; name: string } | null;
    repositories?: string[];
    risk?: { level?: string; reasons?: string[] };
    acceptance_criteria?: string[];
    warnings?: string[];
  } | null>(null);
  const [mode, setMode] = useState<Mode>("AUTO");
  const [provider, setProvider] = useState<string>("auto");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [repoScope, setRepoScope] = useState<string[]>([]);
  const [fallback, setFallback] = useState(true);
  const [menuId, setMenuId] = useState<number | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const composing = useRef(false);
  const detailIdRef = useRef<number | null>(null);
  const grouped = useMemo(() => groupConversations(list.data ?? []), [list.data]);

  const activeId = conversationId ?? detail?.conversation.id ?? null;

  const loadDetail = useCallback(async (id: number) => {
    setLoadingDetail(true);
    setDetailErr("");
    try {
      const d = await api<Detail>(`/api/chat/conversations/${id}`);
      if (detailIdRef.current !== null && detailIdRef.current !== id) return null;
      setDetail(d);
      setLive((l) => (d.active_turn ? seedFromTurn(l, d.active_turn) : null));
      setMode(d.conversation.mode);
      setProvider(
        d.conversation.provider_strategy === "auto" || d.conversation.provider === "auto"
          ? "auto"
          : asProvider(d.conversation.preferred_provider ?? d.conversation.provider),
      );
      setModel(d.conversation.model ?? "");
      setEffort(d.conversation.reasoning_effort ?? "");
      setRepoScope(d.conversation.repositories ?? []);
      setFallback(d.conversation.fallback_enabled !== false);
      return d;
    } catch (e) {
      setDetail(null);
      setDetailErr((e as Error).message);
      return null;
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    detailIdRef.current = conversationId ?? null;
    if (conversationId) void loadDetail(conversationId);
    else setDetail(null);
  }, [conversationId, loadDetail]);

  // One stable EventSource per open conversation — do not recreate on detail object identity.
  useEffect(() => {
    if (!activeId) return;
    const id = activeId;
    const es = new EventSource(`/api/chat/conversations/${id}/stream`, { withCredentials: true });
    const onChat = (ev: MessageEvent) => {
      try {
        const p = JSON.parse(ev.data);
        const kind = String(p.kind ?? "");
        setLive((l) => applyChatEvent(l, p));
        if (kind === "phase.updated") setLiveNote(phaseLabel(p.data?.phase, t));
        else if (kind === "provider.selected")
          setLiveNote(t("chat.live.provider", { provider: p.data?.provider ?? "" }));
        else if (kind === "provider.fallback")
          setLiveNote(t("chat.live.fallback"));
        else if (kind === "tool.started") setLiveNote(t("chat.live.tool", { tool: p.data?.tool ?? "" }));
        else if (kind === "routing.completed")
          setLiveNote(t("chat.live.route", { route: p.data?.route ?? "" }));
        else if (
          kind === "turn.completed" ||
          kind === "turn.failed" ||
          kind === "turn.canceled" ||
          kind === "response.partial" ||
          kind === "operation.updated" ||
          kind === "conversation.updated"
        ) {
          setLiveNote("");
          if (detailIdRef.current === id) void loadDetail(id);
          void list.reloadFresh();
        }
      } catch {
        /* ignore */
      }
    };
    es.addEventListener("chat", onChat as EventListener);
    const poll = setInterval(() => {
      if (detailIdRef.current === id) void loadDetail(id);
    }, 8000);
    return () => {
      es.removeEventListener("chat", onChat as EventListener);
      es.close();
      clearInterval(poll);
    };
  }, [activeId, loadDetail, list, t]);

  useEffect(() => {
    const el = threadRef.current;
    if (!el || !stickBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [detail?.messages, liveNote, detail?.active_turn, detail?.turns, live]);

  const turnsById = useMemo(() => {
    const m = new Map<number, Turn>();
    for (const turn of detail?.turns ?? []) m.set(turn.id, turn);
    return m;
  }, [detail?.turns]);

  const toolsByTurn = useMemo(() => {
    const m = new Map<number, ToolCall[]>();
    for (const tc of detail?.tool_calls ?? []) {
      const arr = m.get(tc.turn_id) ?? [];
      arr.push(tc);
      m.set(tc.turn_id, arr);
    }
    return m;
  }, [detail?.tool_calls]);

  const visiblePending = useMemo(
    () => reconcilePending(pending, activeId, detail?.turns),
    [pending, activeId, detail?.turns],
  );
  useEffect(() => {
    if (!detail) return;
    const id = detail.conversation.id;
    setPending((p) => {
      const keep = reconcilePending(p, id, detail.turns);
      const next = p.filter((x) => x.conversationId !== id || keep.includes(x));
      return next.length === p.length ? p : next;
    });
  }, [detail]);
  const waiting = !!detail?.active_turn || visiblePending.some((p) => p.status === "sending");
  const opsByTurn = useMemo(() => {
    const m = new Map<number | null, Operation[]>();
    const answered = new Set(
      (detail?.messages ?? []).filter((x) => x.role === "assistant" && x.turn_id).map((x) => x.turn_id),
    );
    for (const op of detail?.operations ?? []) {
      const k = op.turn_id != null && answered.has(op.turn_id) ? op.turn_id : null;
      m.set(k, [...(m.get(k) ?? []), op]);
    }
    return m;
  }, [detail?.operations, detail?.messages]);

  const providerOptions = useMemo(() => {
    const rows = providers.data ?? [];
    return [
      { id: "auto", label: t("chat.provider.auto"), ok: true, enabled: true, quota: undefined as string | undefined },
      ...AGENT_PROVIDERS.map((id) => {
        const row = rows.find((p) => p.id === id);
        return {
          id,
          label: t(agentKey(id, true)),
          ok: row?.ok === true,
          enabled: row?.enabled !== false,
          error: row?.error,
          quota: row?.quota,
        };
      }),
    ];
  }, [providers.data, t]);

  const modelOptions = useMemo(() => {
    if (provider === "auto") return [] as Array<{ slug: string; name?: string }>;
    const row = providers.data?.find((p) => p.id === provider);
    return row?.controls?.models ?? [];
  }, [provider, providers.data]);

  const createChat = async () => {
    const c = await act(() =>
      api<Conversation>("/api/chat/conversations", {
        mode,
        provider: provider === "auto" ? "auto" : provider,
        provider_strategy: provider === "auto" ? "auto" : "manual",
        fallback_enabled: fallback,
        model: model || null,
        reasoning_effort: effort || null,
        repositories: repoScope,
      }),
    );
    if (!c) return;
    await list.reloadFresh();
    location.hash = `/chat/${c.id}`;
  };

  const selectionBody = () => ({
    mode,
    provider: provider === "auto" ? "auto" : provider,
    provider_strategy: provider === "auto" ? "auto" : "manual",
    fallback_enabled: fallback,
    model: model || null,
    reasoning_effort: effort || null,
    repositories: repoScope,
  });

  const deliver = async (conversationId: number, cid: string, content: string) => {
    setBusy(true);
    setLiveNote(t("chat.live.thinking"));
    try {
      await api(`/api/chat/conversations/${conversationId}/messages`, {
        content,
        client_message_id: cid,
        ...selectionBody(),
      });
      await loadDetail(conversationId);
      void list.reloadFresh();
    } catch (e) {
      setPending((p) => markPending(p, cid, { status: "failed", error: (e as Error).message }));
      setLiveNote("");
    } finally {
      setBusy(false);
    }
  };

  const send = () => {
    if (!activeId || !draft.trim() || busy || detail?.active_turn) return;
    const content = draft.trim();
    const cid = clientMessageId();
    // Rendered before the request: the server reconciles by this same client_message_id.
    setPending((p) => [
      ...p,
      { cid, conversationId: activeId, content, status: "sending", at: new Date().toISOString() },
    ]);
    setDraft("");
    stickBottom.current = true;
    void deliver(activeId, cid, content);
  };

  const retrySend = (m: PendingMessage) => {
    setPending((p) => markPending(p, m.cid, { status: "sending", error: undefined }));
    void deliver(m.conversationId, m.cid, m.content);
  };

  const decideOperation = async (id: number, decision: "confirm" | "reject") => {
    if (await act(() => api(`/api/chat/operations/${id}/${decision}`, {}))) {
      if (activeId) await loadDetail(activeId);
    }
  };

  const updateMemory = async (key: string, body: Record<string, unknown>) => {
    if (await act(() => api(`/api/knowledge/${key}`, body))) void memories.reloadFresh();
  };
  const deleteMemory = async (key: string) => {
    if (await act(() => api(`/api/knowledge/${key}/delete`, { reason: "removed from chat memory" })))
      void memories.reloadFresh();
  };

  const cancel = async () => {
    const turnId = detail?.active_turn?.id;
    if (!turnId) return;
    if (await act(() => api(`/api/chat/turns/${turnId}/cancel`, {}))) {
      setLiveNote("");
      if (activeId) await loadDetail(activeId);
    }
  };

  const regenerate = async (turnId: number) => {
    if (await act(() => api(`/api/chat/turns/${turnId}/regenerate`, {}))) {
      if (activeId) await loadDetail(activeId);
    }
  };

  const retryTurn = async (turn: Turn) => {
    if (!activeId) return;
    const user = detail?.messages.find((m) => m.turn_id === turn.id && m.role === "user");
    if (!user) return;
    setDraft(user.content);
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(t("chat.copied"), "ok");
    } catch {
      toast(t("chat.copyFail"), "err");
    }
  };

  const patchConversation = async (body: Record<string, unknown>) => {
    if (!activeId) return;
    if (await act(() => api(`/api/chat/conversations/${activeId}`, body))) {
      await loadDetail(activeId);
      void list.reloadFresh();
    }
  };

  const removeConversation = async (id: number) => {
    setMenuId(null);
    const confirmed = await dialog.confirm({
      title: t("chat.delete.title"),
      description: t("chat.deleteConfirm"),
      confirmLabel: t("chat.delete.confirm"),
      cancelLabel: t("common.cancel"),
      variant: "destructive",
    });
    if (!confirmed) return;
    if (await act(() => api(`/api/chat/conversations/${id}/delete`, {}))) {
      await list.reloadFresh();
      if (activeId === id) location.hash = "/chat";
    }
  };

  const renameConversation = async (c: Conversation) => {
    setMenuId(null);
    const next = await dialog.prompt({
      title: t("chat.renameTitle"),
      label: t("chat.renameLabel"),
      defaultValue: c.title || "",
      required: true,
      confirmLabel: t("chat.renameSave"),
      cancelLabel: t("common.cancel"),
      validate: (v) => (v.trim().length > 200 ? t("chat.renameTitle") : null),
    });
    if (next === null) return;
    const title = next.trim();
    if (!title || title === c.title) return;
    if (await act(() => api(`/api/chat/conversations/${c.id}`, { title }))) {
      if (activeId === c.id) await loadDetail(c.id);
      void list.reloadFresh();
    }
  };

  const archiveConversation = async (id: number) => {
    setMenuId(null);
    if (await act(() => api(`/api/chat/conversations/${id}`, { archived: true }))) {
      await list.reloadFresh();
      if (activeId === id) location.hash = "/chat";
    }
  };

  const regenerateTitle = async (c: Conversation) => {
    setMenuId(null);
    if (c.title_source === "manual") {
      toast(t("chat.titleManualLocked"), "err");
      return;
    }
    if (await act(() => api(`/api/chat/conversations/${c.id}/title/regenerate`, {}))) {
      void list.reloadFresh();
      // Generation is async; refresh again after the completion usually settles.
      window.setTimeout(() => void list.reloadFresh(), 3000);
      window.setTimeout(() => void list.reloadFresh(), 10000);
    }
  };

  useEffect(() => {
    if (menuId == null) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (el?.closest?.(`[data-chat-menu="${menuId}"]`)) return;
      setMenuId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuId(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuId]);

  const openDelegation = async (kind: "task" | "investigation" | "plan" | "delegate") => {
    if (!activeId) return;
    const p = await act(() =>
      api<NonNullable<typeof preview>>(`/api/chat/conversations/${activeId}/delegation/preview`, { kind }),
    );
    if (p) setPreview(p);
  };

  const confirmDelegation = async () => {
    if (!activeId || !preview) return;
    const r = await act(() =>
      api<{ work_item_code?: string; work_item_id: number; run_id?: number | null }>(
        `/api/chat/conversations/${activeId}/delegation/execute`, {
        request: {
          workflow: preview.workflow?.key,
          title: preview.title,
          repositories: preview.repositories,
          message_id: preview.source_message_id,
        },
        hash: preview.hash,
        confirmed: true,
      }),
    );
    if (r) {
      setPreview(null);
      toast(
        t("chat.delegated", { code: r.work_item_code ?? r.work_item_id, run: r.run_id ?? "—" }),
        "ok",
      );
      await loadDetail(activeId);
    }
  };

  const usage = detail?.conversation.usage as
    | { cost_usd?: number | null; input_tokens?: number | null; output_tokens?: number | null }
    | undefined;

  return (
    <div className={`chat-page${sideOpen ? "" : " is-side-collapsed"}`}>
      <aside className="chat-side" aria-label={t("chat.list")} hidden={!sideOpen}>
        <div className="chat-side-head">
          <div className="row">
            <h2>{t("nav.chat")}</h2>
            <button className="sm" onClick={() => void createChat()} aria-label={t("chat.new")}>
              <MessageSquarePlus size={16} strokeWidth={1.9} /> {t("chat.new")}
            </button>
          </div>
          <SearchInput value={q} onChange={setQ} placeholder={t("chat.search")} />
        </div>
        <div className="chat-list">
          {list.error && <ErrorBox error={list.error} />}
          {!list.data && !list.error && <Loading label={t("chat.loading")} />}
          {list.data?.length === 0 && (
            <EmptyState icon={MessagesSquare} title={t("chat.emptyList")}>
              {t("chat.emptyListHint")}
            </EmptyState>
          )}
          {grouped.map((group) => (
            <div key={group.key} className="chat-group">
              <h3 className="chat-group-label">{t(`chat.group.${group.key}`)}</h3>
              {group.items.map((c) => (
                <div
                  key={c.id}
                  className={`chat-item${activeId === c.id ? " is-active" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => (location.hash = `/chat/${c.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      location.hash = `/chat/${c.id}`;
                    }
                  }}
                >
                  <span className="chat-item-title" title={c.title || t("chat.untitled")}>
                    {c.title || t("chat.untitled")}
                  </span>
                  {c.active_turn ? (
                    <span className="chat-item-live">{t("chat.live.badge")}</span>
                  ) : null}
                  <div className="chat-item-menu-wrap" data-chat-menu={c.id}>
                    <button
                      type="button"
                      className={`ghost icon sm chat-item-menu-btn${menuId === c.id ? " is-open" : ""}`}
                      aria-label={t("chat.menu")}
                      aria-haspopup="menu"
                      aria-expanded={menuId === c.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuId((id) => (id === c.id ? null : c.id));
                      }}
                    >
                      <MoreHorizontal size={16} />
                    </button>
                    {menuId === c.id ? (
                      <div className="chat-item-menu" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={(e) => {
                            e.stopPropagation();
                            void renameConversation(c);
                          }}
                        >
                          <Pencil size={14} /> {t("chat.rename")}
                        </button>
                        {c.title_source !== "manual" ? (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={(e) => {
                              e.stopPropagation();
                              void regenerateTitle(c);
                            }}
                          >
                            <Sparkles size={14} /> {t("chat.regenerateTitle")}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          role="menuitem"
                          onClick={(e) => {
                            e.stopPropagation();
                            void archiveConversation(c.id);
                          }}
                        >
                          <Archive size={14} /> {t("chat.archive")}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="is-danger"
                          onClick={(e) => {
                            e.stopPropagation();
                            void removeConversation(c.id);
                          }}
                        >
                          <Trash2 size={14} /> {t("chat.delete")}
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <section className="chat-main" aria-label={t("chat.thread")}>
        <div className="chat-toolbar">
          <button
            className="ghost icon sm"
            onClick={() => setSideOpen((v) => !v)}
            aria-label={sideOpen ? t("chat.hideList") : t("chat.showList")}
          >
            {sideOpen ? <ChevronLeft size={16} /> : <PanelLeft size={16} />}
          </button>
          <div className="chat-title">{detail?.conversation.title || t("chat.untitled")}</div>
          <button className="ghost sm" onClick={() => setMemoryOpen(true)}>
            {t("chat.memory")}
          </button>
          {detail && (
            <>
              <button
                className="ghost sm"
                onClick={() => void patchConversation({ archived: true })}
                aria-label={t("chat.archive")}
              >
                <Archive size={15} />
              </button>
              <button
                className="ghost sm danger"
                onClick={() => void removeConversation(detail.conversation.id)}
                aria-label={t("chat.delete")}
              >
                <Trash2 size={15} />
              </button>
            </>
          )}
        </div>

        {!activeId && (
          <div className="chat-empty">
            <MessagesSquare size={36} strokeWidth={1.6} />
            <h3>{t("chat.welcome")}</h3>
            <p className="muted">{t("chat.welcomeHint")}</p>
            <button onClick={() => void createChat()}>{t("chat.new")}</button>
          </div>
        )}
        {activeId && loadingDetail && !detail && <Loading label={t("chat.loading")} />}
        {detailErr && <ErrorBox error={detailErr} />}

        {detail && (
          <>
            <div
              className="chat-thread"
              ref={threadRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
            >
              <div className="chat-thread-inner">
                {detail.messages.length === 0 && (
                  <div className="chat-empty">
                    <p className="muted">{t("chat.startHint")}</p>
                  </div>
                )}
                {detail.messages.map((m) => {
                  const turn = m.turn_id ? turnsById.get(m.turn_id) : undefined;
                  const tools = m.turn_id ? toolsByTurn.get(m.turn_id) : undefined;
                  return (
                    <div key={m.id} className="chat-block">
                      <article className={`chat-bubble is-${m.role}`}>
                        <div className="chat-bubble-meta">
                          <span>
                            {m.role === "user"
                              ? t("chat.role.user")
                              : m.role === "assistant"
                                ? t("chat.role.assistant")
                                : t("chat.role.system")}
                          </span>
                          {m.role === "assistant" && turn?.provider && (
                            <span className="chat-meta-pill">
                              {turn.provider}
                              {turn.model ? ` · ${turn.model}` : ""}
                              {turn.route ? ` · ${turn.route}` : ""}
                            </span>
                          )}
                          {m.role === "assistant" && turn && ["canceled", "failed"].includes(turn.status) && (
                            <span className="chat-meta-pill is-partial">
                              {t(turn.status === "canceled" ? "chat.partial.stopped" : "chat.partial.failed")}
                            </span>
                          )}
                          <span>{ago(m.created_at)}</span>
                        </div>
                        {m.role === "assistant" && !!turn?.trace?.length && (
                          <Reasoning trace={turn.trace} summary={traceSummary(turn, t)} />
                        )}
                        {m.role === "assistant" ? (
                          <Markdown text={m.content} />
                        ) : (
                          <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
                        )}
                        {!!tools?.length && !turn?.trace?.length && (
                          <details className="chat-tools">
                            <summary>{t("chat.tools", { n: tools.length })}</summary>
                            {tools.map((tc) => (
                              <div
                                key={tc.id}
                                className={`chat-tool${tc.status === "ok" ? "" : " is-err"}`}
                              >
                                #{tc.seq} {tc.tool} — {tc.status}
                                {tc.duration_ms != null ? ` (${Math.round(tc.duration_ms)} ms)` : ""}
                              </div>
                            ))}
                          </details>
                        )}
                        {!!m.citations?.length && (
                          <div className="chat-citations">
                            {m.citations.map((c, i) => (
                              <span key={i} className="chat-cite" title={c.ref}>
                                {c.label}
                              </span>
                            ))}
                          </div>
                        )}
                        {m.role === "assistant" && (
                          <div className="chat-bubble-actions">
                            <button className="ghost xs" onClick={() => void copyText(m.content)}>
                              <Copy size={14} />
                            </button>
                            {m.turn_id && !detail.active_turn && (
                              <button className="ghost xs" onClick={() => void regenerate(m.turn_id!)}>
                                <RefreshCw size={14} />
                              </button>
                            )}
                            <button className="ghost xs" onClick={() => void openDelegation("task")}>
                              <Workflow size={14} /> {t("chat.createTask")}
                            </button>
                            <button className="ghost xs" onClick={() => void openDelegation("delegate")}>
                              {t("chat.delegate")}
                            </button>
                          </div>
                        )}
                      </article>
                      {m.role === "assistant" &&
                        m.turn_id != null &&
                        (opsByTurn.get(m.turn_id) ?? []).map((op) => (
                          <OperationCard key={op.id} op={op} onDecide={(id, d) => void decideOperation(id, d)} />
                        ))}
                      {m.role === "user" && turn?.status === "failed" && turn.failure && (
                        <div className="chat-failure" role="alert">
                          <AlertTriangle size={16} />
                          <div>
                            <div className="chat-failure-title">
                              {turn.failure.code ?? "ERROR"}
                              {turn.failure.provider ? ` · ${turn.failure.provider}` : ""}
                            </div>
                            <div>{turn.failure.message}</div>
                            {turn.failure.fallback_attempted && (
                              <div className="muted">{t("chat.failure.fallbackTried")}</div>
                            )}
                            <div className="chat-failure-actions">
                              <button className="sm" onClick={() => void retryTurn(turn)}>
                                {t("chat.retry")}
                              </button>
                              <button
                                className="ghost sm"
                                onClick={() => {
                                  setProvider("auto");
                                  void retryTurn(turn);
                                }}
                              >
                                {t("chat.retryOther")}
                              </button>
                              <a className="btn ghost sm" href="#/settings">
                                {t("chat.openSettings")}
                              </a>
                              <button
                                className="ghost sm"
                                onClick={() => void providers.reloadFresh()}
                              >
                                {t("chat.refreshHealth")}
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {(opsByTurn.get(null) ?? []).map((op) => (
                  <OperationCard key={op.id} op={op} onDecide={(id, d) => void decideOperation(id, d)} />
                ))}

                {visiblePending.map((p) => (
                  <div key={p.cid} className="chat-block">
                    <article className={`chat-bubble is-user is-pending${p.status === "failed" ? " is-failed" : ""}`}>
                      <div className="chat-bubble-meta">
                        <span>{t("chat.role.user")}</span>
                        <span>{p.status === "sending" ? t("chat.sending") : t("chat.sendFailed")}</span>
                      </div>
                      <div style={{ whiteSpace: "pre-wrap" }}>{p.content}</div>
                    </article>
                    {p.status === "failed" && (
                      <div className="chat-failure" role="alert">
                        <AlertTriangle size={16} />
                        <div>
                          <div>{p.error}</div>
                          <div className="chat-failure-actions">
                            <button className="sm" onClick={() => retrySend(p)} disabled={busy || !!detail.active_turn}>
                              {t("chat.retry")}
                            </button>
                            <button
                              className="ghost sm"
                              onClick={() => setPending((all) => all.filter((x) => x.cid !== p.cid))}
                            >
                              {t("chat.discard")}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {waiting && (
                  <div className="chat-block">
                    <article className="chat-bubble is-assistant is-streaming" aria-busy="true">
                      <div className="chat-bubble-meta">
                        <span>{t("chat.role.assistant")}</span>
                        <span className="chat-meta-pill">
                          {[detail.active_turn?.provider, detail.active_turn?.model, detail.active_turn?.route]
                            .filter(Boolean)
                            .join(" · ") || "…"}
                        </span>
                      </div>
                      <div role="status" aria-live="polite">
                        <Reasoning
                          live
                          trace={live?.trace ?? []}
                          summary={
                            liveLabel(live?.status ?? null, t) ||
                            liveNote ||
                            phaseLabel(detail.active_turn?.phase, t)
                          }
                        />
                      </div>
                      {!!live?.text && <Markdown text={live.text} />}
                    </article>
                  </div>
                )}
                {!waiting && liveNote && (
                  <div className="chat-status" role="status">
                    <span className="dot" />
                    <div>{liveNote}</div>
                  </div>
                )}
              </div>
            </div>

            <div className="chat-composer">
              <div className="chat-composer-controls">
                <select
                  aria-label={t("chat.mode")}
                  value={mode}
                  onChange={(e) => {
                    const m = e.target.value as Mode;
                    setMode(m);
                    void patchConversation({ mode: m });
                  }}
                >
                  {MODES.map((m) => (
                    <option key={m} value={m}>
                      {t(`chat.mode.${m}`)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={t("chat.provider")}
                  value={provider}
                  onChange={(e) => {
                    const p = e.target.value;
                    setProvider(p);
                    void patchConversation({
                      provider: p,
                      provider_strategy: p === "auto" ? "auto" : "manual",
                      fallback_enabled: p === "auto" ? true : fallback,
                    });
                  }}
                >
                  {providerOptions
                    .filter((p) => p.id === "auto" || (p.enabled && p.ok && p.quota !== "exhausted") || p.id === provider)
                    .map((p) => (
                    <option key={p.id} value={p.id} disabled={p.id !== "auto" && !p.enabled}>
                      {p.label}
                      {p.id !== "auto" && !p.ok ? ` — ${t("chat.provider.unhealthy")}` : ""}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={t("chat.repos")}
                  value={repoScope[0] ?? ""}
                  onChange={(e) => {
                    const v = e.target.value ? [e.target.value] : [];
                    setRepoScope(v);
                    void patchConversation({ repositories: v });
                  }}
                >
                  <option value="">{t("chat.reposAll")}</option>
                  {(repos.data ?? []).map((r) => (
                    <option key={r.name} value={r.name}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <button
                  className={`ghost sm${advanced ? " on" : ""}`}
                  onClick={() => setAdvanced((v) => !v)}
                  aria-expanded={advanced}
                >
                  <Settings2 size={15} />
                  <ChevronRight size={14} style={{ transform: advanced ? "rotate(90deg)" : undefined }} />
                </button>
              </div>
              {advanced && (
                <div className="chat-advanced">
                  {provider !== "auto" && (
                    <>
                      <select
                        aria-label={t("chat.model")}
                        value={model}
                        onChange={(e) => {
                          setModel(e.target.value);
                          void patchConversation({ model: e.target.value || null });
                        }}
                      >
                        <option value="">{t("chat.modelInherit")}</option>
                        {modelOptions.map((m) => (
                          <option key={m.slug} value={m.slug}>
                            {m.name ?? m.slug}
                          </option>
                        ))}
                      </select>
                      <input
                        aria-label={t("chat.effort")}
                        placeholder={t("chat.effortInherit")}
                        value={effort}
                        onChange={(e) => setEffort(e.target.value)}
                        onBlur={() => void patchConversation({ reasoning_effort: effort || null })}
                      />
                      <label className="chat-check">
                        <input
                          type="checkbox"
                          checked={fallback}
                          onChange={(e) => {
                            setFallback(e.target.checked);
                            void patchConversation({ fallback_enabled: e.target.checked });
                          }}
                        />
                        {t("chat.fallback")}
                      </label>
                    </>
                  )}
                </div>
              )}
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t("chat.placeholder")}
                onCompositionStart={() => (composing.current = true)}
                onCompositionEnd={() => (composing.current = false)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.shiftKey || composing.current) return;
                  e.preventDefault();
                  void send();
                }}
                disabled={!!detail.active_turn}
              />
              <div className="chat-composer-bar">
                <span className="chat-composer-hint">
                  {t("chat.mentionHint")}
                  {usage && (
                    <>
                      {" · "}
                      {t("chat.usage", {
                        cost: usage.cost_usd == null ? "—" : `$${Number(usage.cost_usd).toFixed(4)}`,
                        tokens:
                          usage.input_tokens == null && usage.output_tokens == null
                            ? "—"
                            : `${usage.input_tokens ?? "—"}/${usage.output_tokens ?? "—"}`,
                      })}
                    </>
                  )}
                </span>
                {detail.active_turn ? (
                  <button className="warn" onClick={() => void cancel()}>
                    <Square size={15} /> {t("chat.stop")}
                  </button>
                ) : (
                  <button onClick={() => void send()} disabled={!draft.trim() || busy}>
                    <Send size={15} /> {t("chat.send")}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </section>

      {memoryOpen && (
        <div className="chat-modal" role="dialog" aria-modal="true" aria-label={t("chat.memory")}>
          <div className="chat-modal-card">
            <h3>{t("chat.memory")}</h3>
            <p className="muted">{t("chat.memory.hint")}</p>
            {memories.error && <ErrorBox error={memories.error} />}
            {!memories.data && !memories.error && <Loading />}
            {memories.data?.length === 0 && <p className="muted">{t("chat.memory.empty")}</p>}
            <div className="chat-memory-list">
              {(memories.data ?? []).map((m) => (
                <div key={m.key} className={`chat-memory${m.enabled ? "" : " is-disabled"}`}>
                  <div className="chat-memory-head">
                    <span className="chat-meta-pill">{m.metadata?.memory?.kind ?? "memory"}</span>
                    {(m.metadata?.memory?.count ?? 1) > 1 && (
                      <span className="muted">×{m.metadata?.memory?.count}</span>
                    )}
                  </div>
                  <div>{m.content}</div>
                  <div className="chat-failure-actions">
                    <button className="ghost xs" onClick={() => void updateMemory(m.key, { enabled: !m.enabled })}>
                      {m.enabled ? t("chat.memory.disable") : t("chat.memory.enable")}
                    </button>
                    <button
                      className="ghost xs"
                      onClick={async () => {
                        const content = await dialog.prompt({
                          title: t("chat.memory.edit"),
                          defaultValue: m.content,
                        });
                        if (content && content.trim() !== m.content) void updateMemory(m.key, { content: content.trim() });
                      }}
                    >
                      {t("chat.memory.edit")}
                    </button>
                    <button className="ghost xs danger" onClick={() => void deleteMemory(m.key)}>
                      {t("chat.memory.delete")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="chat-failure-actions">
              <button className="ghost sm" onClick={() => setMemoryOpen(false)}>
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      )}

      {preview && (
        <div className="chat-modal" role="dialog" aria-modal="true">
          <div className="chat-modal-card">
            <h3>{t("chat.preview")}</h3>
            <dl className="chat-preview-grid">
              <dt>{t("chat.preview.title")}</dt>
              <dd>{preview.title}</dd>
              <dt>{t("chat.preview.workflow")}</dt>
              <dd>
                {preview.workflow
                  ? `${preview.workflow.name} (${preview.workflow.key})`
                  : t("chat.preview.noWorkflow")}
              </dd>
              <dt>{t("chat.preview.risk")}</dt>
              <dd>{preview.risk?.level ?? "—"}</dd>
            </dl>
            <div className="chat-modal-actions">
              <button className="ghost" onClick={() => setPreview(null)}>
                {t("chat.cancel")}
              </button>
              <button onClick={() => void confirmDelegation()} disabled={!preview.workflow}>
                {t("chat.confirmDelegate")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
