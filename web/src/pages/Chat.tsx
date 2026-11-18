import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Copy,
  MessageSquarePlus,
  MessagesSquare,
  PanelLeft,
  RefreshCw,
  Send,
  Settings2,
  Square,
  Trash2,
  Workflow,
  AlertTriangle,
} from "lucide-react";
import { api, useApi } from "../api.ts";
import { AGENT_PROVIDERS, agentKey, asProvider } from "../agentProvider.tsx";
import { EmptyState, ErrorBox, Loading, Markdown, SearchInput, act, ago, toast } from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";
import "./Chat.css";

type Mode = "AUTO" | "ASK" | "INVESTIGATE" | "PLAN" | "DELEGATE";

type Conversation = {
  id: number;
  title: string;
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
};

type Detail = {
  conversation: Conversation;
  messages: Message[];
  tool_calls: ToolCall[];
  turns: Turn[];
  active_turn: Turn | null;
  delegations: Array<{ id: number; work_item_id: number | null; run_id: number | null; work_item_code?: string }>;
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

function phaseLabel(phase: string | null | undefined, t: (k: string, p?: Record<string, string | number>) => string) {
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
  const threadRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const composing = useRef(false);
  const detailIdRef = useRef<number | null>(null);

  const activeId = conversationId ?? detail?.conversation.id ?? null;

  const loadDetail = useCallback(async (id: number) => {
    setLoadingDetail(true);
    setDetailErr("");
    try {
      const d = await api<Detail>(`/api/chat/conversations/${id}`);
      if (detailIdRef.current !== null && detailIdRef.current !== id) return null;
      setDetail(d);
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
  }, [detail?.messages, liveNote, detail?.active_turn, detail?.turns]);

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

  const providerOptions = useMemo(() => {
    const rows = providers.data ?? [];
    return [
      { id: "auto", label: t("chat.provider.auto"), ok: true, enabled: true },
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

  const send = async () => {
    if (!activeId || !draft.trim() || busy || detail?.active_turn) return;
    setBusy(true);
    const content = draft.trim();
    setDraft("");
    stickBottom.current = true;
    setLiveNote(t("chat.live.thinking"));
    const r = await act(() =>
      api(`/api/chat/conversations/${activeId}/messages`, {
        content,
        client_message_id: clientMessageId(),
        ...selectionBody(),
      }),
    );
    setBusy(false);
    if (r) {
      await loadDetail(activeId);
      void list.reloadFresh();
    } else {
      setDraft(content);
      setLiveNote("");
    }
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
    if (!confirm(t("chat.deleteConfirm"))) return;
    if (await act(() => api(`/api/chat/conversations/${id}/delete`, {}))) {
      await list.reloadFresh();
      if (activeId === id) location.hash = "/chat";
    }
  };

  const openDelegation = async (kind: "task" | "investigation" | "plan" | "delegate") => {
    if (!activeId) return;
    const p = await act(() =>
      api(`/api/chat/conversations/${activeId}/delegation/preview`, { kind }),
    );
    if (p) setPreview(p);
  };

  const confirmDelegation = async () => {
    if (!activeId || !preview) return;
    const r = await act(() =>
      api(`/api/chat/conversations/${activeId}/delegation/execute`, {
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
          {list.data?.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`chat-item${activeId === c.id ? " is-active" : ""}`}
              onClick={() => (location.hash = `/chat/${c.id}`)}
            >
              <span className="chat-item-title">{c.title || t("chat.untitled")}</span>
              <span className="chat-item-preview">{c.last_message || t("chat.noMessages")}</span>
              <span className="chat-item-meta">
                <span>{c.mode}</span>
                <span>{ago(c.updated_at)}</span>
                {c.active_turn ? <span className="pill">{t("chat.live.badge")}</span> : null}
              </span>
            </button>
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
                          <span>{ago(m.created_at)}</span>
                        </div>
                        {m.role === "assistant" ? (
                          <Markdown text={m.content} />
                        ) : (
                          <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
                        )}
                        {!!tools?.length && (
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

                {(detail.active_turn || liveNote) && (
                  <div className="chat-status" role="status">
                    <span className="dot" />
                    <div>
                      <div>{liveNote || phaseLabel(detail.active_turn?.phase, t)}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {[detail.active_turn?.provider, detail.active_turn?.model, detail.active_turn?.route]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
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
                  {providerOptions.map((p) => (
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
