import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Copy,
  MessageSquarePlus,
  MessagesSquare,
  RefreshCw,
  Send,
  Square,
  Trash2,
  Workflow,
} from "lucide-react";
import { api, useApi } from "../api.ts";
import { AGENT_PROVIDERS, agentKey, asProvider } from "../agentProvider.tsx";
import {
  EmptyState,
  ErrorBox,
  Loading,
  Markdown,
  SearchInput,
  act,
  ago,
  toast,
} from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";
import "./Chat.css";

type Mode = "ASK" | "INVESTIGATE" | "PLAN" | "DELEGATE";

type Conversation = {
  id: number;
  title: string;
  mode: Mode;
  provider: string | null;
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
  mentions?: unknown[];
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
  label?: string;
};

type ActiveTurn = {
  id: number;
  status: string;
  route?: string | null;
  provider?: string | null;
  model?: string | null;
  error?: string | null;
  metrics?: Record<string, unknown>;
} | null;

type Detail = {
  conversation: Conversation;
  messages: Message[];
  tool_calls: ToolCall[];
  active_turn: ActiveTurn;
  delegations: Array<{
    id: number;
    work_item_id: number | null;
    run_id: number | null;
    work_item_code?: string;
  }>;
};

const MODES: Mode[] = ["ASK", "INVESTIGATE", "PLAN", "DELEGATE"];

function clientMessageId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function systemLabel(content: string, t: (k: string, p?: Record<string, string | number>) => string) {
  try {
    const j = JSON.parse(content);
    if (j?.type === "delegation")
      return t("chat.system.delegated", {
        wi: j.work_item_id ?? "—",
        run: j.run_id ?? "—",
      });
  } catch {
    /* plain text */
  }
  return content;
}

export function ChatPage({ conversationId }: { conversationId?: number }) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const list = useApi<Conversation[]>(
    `/api/chat/conversations${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`,
  );
  const providers = useApi<Array<{ id: string; enabled?: boolean; ok?: boolean }>>(
    "/api/agent-providers",
  );
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
    kind?: string;
    workflow?: { key: string; name: string } | null;
    repositories?: string[];
    risk?: { level?: string; reasons?: string[] };
    acceptance_criteria?: string[];
    warnings?: string[];
  } | null>(null);
  const [mode, setMode] = useState<Mode>("ASK");
  const [provider, setProvider] = useState<string>("claude");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [repoScope, setRepoScope] = useState<string[]>([]);
  const threadRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);
  const esRef = useRef<EventSource | null>(null);

  const activeId = conversationId ?? detail?.conversation.id;

  const loadDetail = useCallback(async (id: number) => {
    setLoadingDetail(true);
    setDetailErr("");
    try {
      const d = await api<Detail>(`/api/chat/conversations/${id}`);
      setDetail(d);
      setMode(d.conversation.mode);
      setProvider(asProvider(d.conversation.provider));
      setModel(d.conversation.model ?? "");
      setEffort(d.conversation.reasoning_effort ?? "");
      setRepoScope(d.conversation.repositories ?? []);
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
    if (conversationId) void loadDetail(conversationId);
    else setDetail(null);
  }, [conversationId, loadDetail]);

  // SSE for the open conversation: reconnect with Last-Event-ID via the browser; also poll as fallback.
  useEffect(() => {
    if (!activeId) return;
    esRef.current?.close();
    const es = new EventSource(`/api/chat/conversations/${activeId}/stream`, {
      withCredentials: true,
    });
    esRef.current = es;
    const onChat = (ev: MessageEvent) => {
      try {
        const p = JSON.parse(ev.data);
        const kind = String(p.kind ?? "");
        if (kind === "tool.started") setLiveNote(t("chat.live.tool", { tool: p.data?.tool ?? "" }));
        else if (kind === "tool.completed" || kind === "tool.failed")
          setLiveNote(t("chat.live.toolDone", { tool: p.data?.tool ?? "", status: p.data?.status }));
        else if (kind === "turn.started")
          setLiveNote(t("chat.live.started", { route: p.data?.route ?? "" }));
        else if (
          kind === "turn.completed" ||
          kind === "turn.failed" ||
          kind === "turn.canceled" ||
          kind === "conversation.updated"
        ) {
          setLiveNote("");
          void loadDetail(activeId);
          void list.reloadFresh();
        }
      } catch {
        /* ignore */
      }
    };
    es.addEventListener("chat", onChat as EventListener);
    es.onerror = () => {
      /* EventSource reconnects; polling below covers gaps */
    };
    const poll = setInterval(() => {
      if (detail?.active_turn) void loadDetail(activeId);
    }, 4000);
    return () => {
      es.removeEventListener("chat", onChat as EventListener);
      es.close();
      clearInterval(poll);
    };
  }, [activeId, detail?.active_turn, loadDetail, list, t]);

  useEffect(() => {
    const el = threadRef.current;
    if (!el || !stickBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [detail?.messages, liveNote, detail?.active_turn]);

  const enabledProviders = useMemo(
    () =>
      AGENT_PROVIDERS.filter((id) => {
        const row = providers.data?.find((p) => p.id === id);
        return row?.enabled !== false;
      }),
    [providers.data],
  );

  const toolsByTurn = useMemo(() => {
    const m = new Map<number, ToolCall[]>();
    for (const tc of detail?.tool_calls ?? []) {
      const arr = m.get(tc.turn_id) ?? [];
      arr.push(tc);
      m.set(tc.turn_id, arr);
    }
    return m;
  }, [detail?.tool_calls]);

  const createChat = async () => {
    const c = await act(() =>
      api<Conversation>("/api/chat/conversations", {
        mode,
        provider,
        model: model || null,
        reasoning_effort: effort || null,
        repositories: repoScope,
      }),
    );
    if (!c) return;
    await list.reloadFresh();
    location.hash = `/chat/${c.id}`;
  };

  const send = async () => {
    if (!activeId || !draft.trim() || busy) return;
    setBusy(true);
    const content = draft.trim();
    setDraft("");
    const r = await act(() =>
      api(`/api/chat/conversations/${activeId}/messages`, {
        content,
        client_message_id: clientMessageId(),
        mode,
        provider,
        model: model || null,
        reasoning_effort: effort || null,
        repositories: repoScope,
      }),
    );
    setBusy(false);
    if (r) {
      stickBottom.current = true;
      await loadDetail(activeId);
      void list.reloadFresh();
    } else setDraft(content);
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
    const r = await act(() => api(`/api/chat/conversations/${activeId}`, body));
    if (r && activeId) await loadDetail(activeId);
    void list.reloadFresh();
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
          kind: preview.workflow?.key?.includes("investig")
            ? "investigation"
            : preview.kind ?? "delegate",
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
        t("chat.delegated", {
          code: r.work_item_code ?? r.work_item_id,
          run: r.run_id ?? "—",
        }),
        "ok",
      );
      await loadDetail(activeId);
      void list.reloadFresh();
    }
  };

  const usage = detail?.conversation.usage as
    | { cost_usd?: number | null; input_tokens?: number | null; output_tokens?: number | null }
    | undefined;

  return (
    <div className="chat-page">
      <aside className="chat-side" aria-label={t("chat.list")}>
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
            <div className="chat-toolbar">
              <div className="chat-title">{detail.conversation.title || t("chat.untitled")}</div>
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
                  void patchConversation({ provider: p });
                }}
              >
                {enabledProviders.map((id) => (
                  <option key={id} value={id}>
                    {t(agentKey(id, true))}
                  </option>
                ))}
              </select>
              <input
                aria-label={t("chat.model")}
                placeholder={t("chat.modelInherit")}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onBlur={() => void patchConversation({ model: model || null })}
              />
              <input
                aria-label={t("chat.effort")}
                placeholder={t("chat.effortInherit")}
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
                onBlur={() => void patchConversation({ reasoning_effort: effort || null })}
              />
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
            </div>

            <div
              className="chat-thread"
              ref={threadRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
            >
              {detail.messages.length === 0 && (
                <div className="chat-empty">
                  <p className="muted">{t("chat.startHint")}</p>
                </div>
              )}
              {detail.messages.map((m) => {
                const tools = m.turn_id ? toolsByTurn.get(m.turn_id) : undefined;
                return (
                  <article
                    key={m.id}
                    className={`chat-bubble is-${m.role}${m.withheld ? " is-withheld" : ""}`}
                  >
                    <div className="chat-bubble-meta">
                      <span>
                        {m.role === "user"
                          ? t("chat.role.user")
                          : m.role === "assistant"
                            ? t("chat.role.assistant")
                            : t("chat.role.system")}
                      </span>
                      <span>{ago(m.created_at)}</span>
                    </div>
                    {m.role === "assistant" ? (
                      <Markdown text={m.content} />
                    ) : m.role === "system" ? (
                      <div>{systemLabel(m.content, t)}</div>
                    ) : (
                      <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
                    )}
                    {!!tools?.length && (
                      <details className="chat-tools">
                        <summary>
                          {t("chat.tools", { n: tools.length })}
                        </summary>
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
                        <button
                          className="ghost xs"
                          onClick={() => void copyText(m.content)}
                          aria-label={t("chat.copy")}
                        >
                          <Copy size={14} />
                        </button>
                        {m.turn_id && !detail.active_turn && (
                          <button
                            className="ghost xs"
                            onClick={() => void regenerate(m.turn_id!)}
                            aria-label={t("chat.regenerate")}
                          >
                            <RefreshCw size={14} />
                          </button>
                        )}
                        <button
                          className="ghost xs"
                          onClick={() => void openDelegation("task")}
                          aria-label={t("chat.createTask")}
                        >
                          <Workflow size={14} /> {t("chat.createTask")}
                        </button>
                        <button
                          className="ghost xs"
                          onClick={() => void openDelegation("investigation")}
                        >
                          {t("chat.runInvestigation")}
                        </button>
                        <button className="ghost xs" onClick={() => void openDelegation("plan")}>
                          {t("chat.generatePlan")}
                        </button>
                        <button
                          className="ghost xs"
                          onClick={() => void openDelegation("delegate")}
                        >
                          {t("chat.delegate")}
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
              {(detail.active_turn || liveNote) && (
                <div className="chat-status" role="status">
                  <span className="dot" />
                  {liveNote || t("chat.live.thinking")}
                  {detail.active_turn?.route ? ` · ${detail.active_turn.route}` : ""}
                  {detail.active_turn?.model ? ` · ${detail.active_turn.model}` : ""}
                </div>
              )}
            </div>

            <div className="chat-composer">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t("chat.placeholder")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void send();
                  }
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
                        cost:
                          usage.cost_usd == null ? "—" : `$${Number(usage.cost_usd).toFixed(4)}`,
                        tokens:
                          usage.input_tokens == null && usage.output_tokens == null
                            ? "—"
                            : `${usage.input_tokens ?? "—"}/${usage.output_tokens ?? "—"}`,
                      })}
                    </>
                  )}
                  {detail.conversation.work_item_id != null && (
                    <>
                      {" · "}
                      <a href={`#/work-items/${detail.conversation.work_item_id}`}>
                        WI #{detail.conversation.work_item_id}
                      </a>
                    </>
                  )}
                  {detail.conversation.run_id != null && (
                    <>
                      {" · "}
                      <a href={`#/runs/${detail.conversation.run_id}`}>
                        Run #{detail.conversation.run_id}
                      </a>
                    </>
                  )}
                </span>
                <div className="row" style={{ gap: 8 }}>
                  {detail.active_turn ? (
                    <button className="warn" onClick={() => void cancel()}>
                      <Square size={15} /> {t("chat.stop")}
                    </button>
                  ) : (
                    <button
                      onClick={() => void send()}
                      disabled={!draft.trim() || busy}
                    >
                      <Send size={15} /> {t("chat.send")}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </section>

      {preview && (
        <div className="chat-modal" role="dialog" aria-modal="true" aria-label={t("chat.preview")}>
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
              <dt>{t("chat.preview.repos")}</dt>
              <dd>{(preview.repositories ?? []).join(", ") || "—"}</dd>
              <dt>{t("chat.preview.risk")}</dt>
              <dd>
                {preview.risk?.level}
                {preview.risk?.reasons?.length
                  ? ` — ${preview.risk.reasons.join("; ")}`
                  : ""}
              </dd>
              <dt>{t("chat.preview.criteria")}</dt>
              <dd>
                {(preview.acceptance_criteria ?? []).length ? (
                  <ul>
                    {(preview.acceptance_criteria as string[]).map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                ) : (
                  "—"
                )}
              </dd>
              <dt>{t("chat.preview.warnings")}</dt>
              <dd>
                {(preview.warnings ?? []).length ? (
                  <ul>
                    {(preview.warnings as string[]).map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                ) : (
                  t("chat.preview.noWarnings")
                )}
              </dd>
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
