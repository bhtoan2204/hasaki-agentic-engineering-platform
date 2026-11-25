import "./Chat.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  MessageSquarePlus,
  MessagesSquare,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Send,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  Workflow,
  AlertTriangle,
  Paperclip,
  X,
} from "lucide-react";
import { api, useApi } from "../api.ts";
import { AGENT_PROVIDERS, agentKey, asProvider } from "../agentProvider.tsx";
import { dialog } from "../dialog/index.ts";
import {
  Drawer,
  EmptyState,
  ErrorBox,
  Loading,
  Markdown,
  SearchInput,
  act,
  toast,
} from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";
import { applyChatEvent, seedFromTurn, type LiveStatus, type LiveTurn } from "./chatStream.ts";
import { markPending, reconcilePending, type PendingMessage } from "./chatOptimistic.ts";
import { ChatImportReview, type ImportedProposal } from "./ChatImportReview.tsx";
import { ChatDelegations } from "./ChatDelegations.tsx";
import { ChatMessages } from "./Chat/ChatMessages.tsx";
import { Reasoning } from "./Chat/Reasoning.tsx";
import {
  type ChatActions,
  type Conversation,
  DOCUMENT_EXT,
  type DateGroupKey,
  DocChips,
  IMAGE_TYPES,
  type Message,
  type Mode,
  type Operation,
  Operations,
  type T,
  Thumbs,
  type ToolCall,
  type Turn,
  dateGroupKey,
  isImage,
} from "./Chat/shared.tsx";

function groupConversations(rows: Conversation[]) {
  const order: DateGroupKey[] = ["today", "yesterday", "week", "older"];
  const map = new Map<DateGroupKey, Conversation[]>();
  for (const key of order) map.set(key, []);
  for (const row of rows) map.get(dateGroupKey(row.updated_at))!.push(row);
  return order.map((key) => ({ key, items: map.get(key)! })).filter((g) => g.items.length > 0);
}

const IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGES_PER_MESSAGE = 4;

const DOCUMENT_BYTES = 10 * 1024 * 1024;

const DOCUMENTS_PER_MESSAGE = 10;

const TOTAL_BYTES = 40 * 1024 * 1024;

/** Pasted text longer than this becomes a .txt attachment instead of filling the composer and the bubble. */
const PASTE_AS_FILE_CHARS = 4000;

const isDocument = (f: File) => !isImage(f) && DOCUMENT_EXT.test(f.name);

/** Base64 of a file (the upload body); the bytes are validated again by the server. */
const base64Of = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error ?? new Error("could not read the image"));
    r.readAsDataURL(file);
  });

type Memory = {
  key: string;
  title: string;
  enabled: boolean;
  content: string;
  metadata?: { memory?: { kind?: string; count?: number } };
};

type Detail = {
  conversation: Conversation;
  messages: Message[];
  tool_calls: ToolCall[];
  turns: Turn[];
  active_turn: Turn | null;
  delegations: Array<{
    id: number;
    work_item_id: number | null;
    run_id: number | null;
    work_item_code?: string;
  }>;
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

function liveLabel(status: LiveStatus, t: T) {
  return status ? t(`chat.status.${status}`) : "";
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
  const [images, setImages] = useState<Array<{ url: string; file: File }>>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const addImages = (files: File[]) => {
    const ok: Array<{ url: string; file: File }> = [];
    const docs: File[] = [];
    for (const f of files) {
      if (isDocument(f)) {
        if (f.size > DOCUMENT_BYTES) toast(t("chat.attach.docSize", { name: f.name }), "err");
        else docs.push(f);
      } else if (!isImage(f)) toast(t("chat.attach.type"), "err");
      else if (f.size > IMAGE_BYTES) toast(t("chat.attach.size"), "err");
      else ok.push({ url: URL.createObjectURL(f), file: f });
    }
    setImages((cur) => {
      const room = IMAGES_PER_MESSAGE - cur.length;
      if (ok.length > room) toast(t("chat.attach.limit", { n: IMAGES_PER_MESSAGE }), "err");
      for (const extra of ok.slice(Math.max(0, room))) URL.revokeObjectURL(extra.url);
      return [...cur, ...ok.slice(0, Math.max(0, room))];
    });
    if (docs.length)
      setDocuments((cur) => {
        const room = DOCUMENTS_PER_MESSAGE - cur.length;
        if (docs.length > room)
          toast(t("chat.attach.docLimit", { n: DOCUMENTS_PER_MESSAGE }), "err");
        const next = [...cur, ...docs.slice(0, Math.max(0, room))];
        if (next.reduce((n, f) => n + f.size, 0) > TOTAL_BYTES) {
          toast(t("chat.attach.total"), "err");
          return cur;
        }
        return next;
      });
  };
  const [documents, setDocuments] = useState<File[]>([]);
  const removeImage = (url: string) => {
    URL.revokeObjectURL(url);
    setImages((cur) => cur.filter((i) => i.url !== url));
  };
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

  const detailSeq = useRef(0);
  const loadDetail = useCallback(async (id: number) => {
    // Latest request wins: an older response arriving late must not replace a newer state (a reverted transcript).
    const n = ++detailSeq.current;
    setLoadingDetail(true);
    setDetailErr("");
    try {
      const d = await api<Detail>(`/api/chat/conversations/${id}`);
      if (n !== detailSeq.current) return null;
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
      if (n !== detailSeq.current) return null;
      setDetail(null);
      setDetailErr((e as Error).message);
      return null;
    } finally {
      if (n === detailSeq.current) setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    detailIdRef.current = conversationId ?? null;
    // The live turn and its status line belong to the conversation being left.
    setLive(null);
    setLiveNote("");
    if (conversationId) void loadDetail(conversationId);
    else setDetail(null);
  }, [conversationId, loadDetail]);

  // Latest values for the stream handlers below; the stream itself depends only on the open conversation.
  const reloadList = useRef(list.reloadFresh);
  reloadList.current = list.reloadFresh;
  const tRef = useRef(t);
  tRef.current = t;
  /** A turn is running or a message is being sent (set below, once `waiting` is known). */
  const turnActive = useRef(false);

  /**
   * One EventSource per open conversation: created when it opens, closed when it changes or the page unmounts — never
   * because the page rendered. (It used to depend on the `useApi` result, a new object on every render, so every
   * streamed delta and every keystroke closed the stream and opened another, losing events in between.) The browser
   * reconnects by itself with Last-Event-ID and the server replays the gap. Polling is the recovery path only: while
   * the stream is down, or while the server reports its LISTEN down (`hello.live === false`).
   */
  useEffect(() => {
    if (!activeId) return;
    const id = activeId;
    const es = new EventSource(`/api/chat/conversations/${id}/stream`, { withCredentials: true });
    let poll: ReturnType<typeof setInterval> | null = null;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    let withList = false;
    let interrupted = false;
    /** Terminal and update events come in bursts (completed, partial, title): one detail (and list) reload each. */
    const reload = (list: boolean) => {
      withList ||= list;
      reloadTimer ??= setTimeout(() => {
        reloadTimer = null;
        if (detailIdRef.current === id) void loadDetail(id);
        if (withList) void reloadList.current();
        withList = false;
      }, 50);
    };
    const startPolling = () => {
      poll ??= setInterval(() => {
        if (document.visibilityState === "visible" && detailIdRef.current === id)
          void loadDetail(id);
      }, 8000);
    };
    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };
    const onHello = (ev: MessageEvent) => {
      let h: { live?: boolean; reset?: boolean } = {};
      try {
        h = JSON.parse(ev.data);
      } catch {
        /* ignore */
      }
      if (h.live === false) startPolling();
      else stopPolling();
      // Replayed events cover a short gap. The stored state is needed once after a gap too large to replay, after an
      // interruption, and when a turn may have ended between the detail request and this stream's start.
      if (h.reset || interrupted || turnActive.current) reload(false);
      interrupted = false;
    };
    const onChat = (ev: MessageEvent) => {
      try {
        const p = JSON.parse(ev.data);
        const kind = String(p.kind ?? "");
        const t = tRef.current;
        setLive((l) => applyChatEvent(l, p));
        if (kind === "phase.updated") setLiveNote(phaseLabel(p.data?.phase, t));
        else if (kind === "provider.selected")
          setLiveNote(t("chat.live.provider", { provider: p.data?.provider ?? "" }));
        else if (kind === "provider.fallback") setLiveNote(t("chat.live.fallback"));
        else if (kind === "tool.started")
          setLiveNote(t("chat.live.tool", { tool: p.data?.tool ?? "" }));
        else if (kind === "repositories.resolved")
          setLiveNote(
            t("chat.live.sources", {
              repos: ((p.data?.repositories ?? []) as Array<{ name: string }>)
                .map((r) => r.name)
                .join(", "),
            }),
          );
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
          reload(true);
        }
      } catch {
        /* ignore */
      }
    };
    es.addEventListener("hello", onHello as EventListener);
    es.addEventListener("chat", onChat as EventListener);
    es.onerror = () => {
      interrupted = true;
      startPolling();
    };
    return () => {
      es.removeEventListener("hello", onHello as EventListener);
      es.removeEventListener("chat", onChat as EventListener);
      es.onerror = null;
      es.close();
      stopPolling();
      if (reloadTimer) clearTimeout(reloadTimer);
    };
  }, [activeId, loadDetail]);

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
  turnActive.current = waiting;
  const opsByTurn = useMemo(() => {
    const m = new Map<number | null, Operation[]>();
    const answered = new Set(
      (detail?.messages ?? [])
        .filter((x) => x.role === "assistant" && x.turn_id)
        .map((x) => x.turn_id),
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
      {
        id: "auto",
        label: t("chat.provider.auto"),
        ok: true,
        enabled: true,
        quota: undefined as string | undefined,
      },
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

  const deliver = async (
    conversationId: number,
    cid: string,
    content: string,
    pendingImages?: PendingMessage,
  ) => {
    setBusy(true);
    setLiveNote(t("chat.live.thinking"));
    try {
      // Images are uploaded once; a retry of the same message reuses their ids.
      let attachments = pendingImages?.attachmentIds;
      const files = [
        ...(pendingImages?.images ?? []).map((i) => i.file),
        ...(pendingImages?.documents ?? []),
      ];
      if (!attachments && files.length) {
        attachments = [];
        for (const file of files) {
          try {
            const up = await api<{ id: number }>(
              `/api/chat/conversations/${conversationId}/attachments`,
              {
                data: await base64Of(file),
                filename: file.name,
              },
            );
            attachments.push(up.id);
          } catch (e) {
            throw new Error(`${file.name}: ${(e as Error).message}`);
          }
        }
        const ids = attachments;
        setPending((p) => markPending(p, cid, { attachmentIds: ids }));
      }
      await api(`/api/chat/conversations/${conversationId}/messages`, {
        content,
        client_message_id: cid,
        ...(attachments?.length ? { attachments } : {}),
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
    if (
      !activeId ||
      (!draft.trim() && !images.length && !documents.length) ||
      busy ||
      detail?.active_turn
    )
      return;
    const content = draft.trim();
    const cid = clientMessageId();
    const message: PendingMessage = {
      cid,
      conversationId: activeId,
      content,
      ...(images.length ? { images } : {}),
      ...(documents.length ? { documents } : {}),
      status: "sending",
      at: new Date().toISOString(),
    };
    // Rendered before the request: the server reconciles by this same client_message_id.
    setPending((p) => [...p, message]);
    setDraft("");
    setImages([]);
    setDocuments([]);
    stickBottom.current = true;
    void deliver(activeId, cid, content, message);
  };

  const retrySend = (m: PendingMessage) => {
    setPending((p) => markPending(p, m.cid, { status: "sending", error: undefined }));
    void deliver(m.conversationId, m.cid, m.content, m);
  };

  const decideOperation = async (id: number, decision: "confirm" | "reject") => {
    if (await act(() => api(`/api/chat/operations/${id}/${decision}`, {}))) {
      if (activeId) await loadDetail(activeId);
    }
  };

  const decideOperations = async (ids: number[], decision: "confirm" | "reject") => {
    const ok = await act(async () => {
      for (const id of ids) await api(`/api/chat/operations/${id}/${decision}`, {});
    });
    if (ok && activeId) await loadDetail(activeId);
  };

  const updateMemory = async (key: string, body: Record<string, unknown>) => {
    if (await act(() => api(`/api/knowledge/${key}`, body))) void memories.reloadFresh();
  };
  const deleteMemory = async (key: string) => {
    if (
      await act(() => api(`/api/knowledge/${key}/delete`, { reason: "removed from chat memory" }))
    )
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

  type DelegationKind = "task" | "investigation" | "plan" | "delegate";
  const openDelegation = async (
    request: DelegationKind | { kind: DelegationKind; title?: string; repositories?: string[] },
  ) => {
    if (!activeId) return;
    const body = typeof request === "string" ? { kind: request } : request;
    const p = await act(() =>
      api<NonNullable<typeof preview>>(
        `/api/chat/conversations/${activeId}/delegation/preview`,
        body,
      ),
    );
    if (p) setPreview(p);
  };
  // Document imports of this conversation (knowledge.propose_import results): reviewed in place.
  const imports = useMemo(
    () =>
      (detail?.tool_calls ?? [])
        .filter((c) => c.tool === "knowledge.propose_import" && c.status === "ok")
        .slice(-3)
        .map((c) => {
          const r = c.result as {
            scope?: string;
            proposals?: ImportedProposal[];
            errors?: Array<{ filename: string; error: string }>;
          };
          return {
            id: c.id,
            scope: r?.scope ?? "",
            proposals: r?.proposals ?? [],
            errors: r?.errors ?? [],
          };
        }),
    [detail?.tool_calls],
  );
  // A task the agent proposed in the latest turn (work.delegate): reviewed and started through the same preview.
  const proposal = useMemo(() => {
    // Turns arrive newest first; take the highest id rather than trust the order.
    const last = (detail?.turns ?? []).reduce<Turn | undefined>(
      (a, b) => (!a || b.id > a.id ? b : a),
      undefined,
    );
    const call = [...(detail?.tool_calls ?? [])]
      .reverse()
      .find((c) => c.tool === "work.delegate" && c.status === "ok" && c.turn_id === last?.id);
    const request = (
      call?.result as
        { request?: { kind: DelegationKind; title: string; repositories: string[] } } | undefined
    )?.request;
    return request && !detail?.active_turn ? request : null;
  }, [detail?.turns, detail?.tool_calls, detail?.active_turn]);

  const [runsVersion, setRunsVersion] = useState(0);
  const confirmDelegation = async () => {
    if (!activeId || !preview) return;
    const r = await act(() =>
      api<{ work_item_code?: string; work_item_id: number; run_id?: number | null }>(
        `/api/chat/conversations/${activeId}/delegation/execute`,
        {
          request: {
            workflow: preview.workflow?.key,
            title: preview.title,
            repositories: preview.repositories,
            message_id: preview.source_message_id,
          },
          hash: preview.hash,
          confirmed: true,
        },
      ),
    );
    if (r) {
      setPreview(null);
      setRunsVersion((v) => v + 1);
      toast(
        t("chat.delegated", { code: r.work_item_code ?? r.work_item_id, run: r.run_id ?? "—" }),
        "ok",
      );
      await loadDetail(activeId);
    }
  };

  // Stable handlers for the memoized transcript; they call the latest closures.
  const latest = useRef({
    copyText,
    regenerate,
    openDelegation,
    decideOperation,
    decideOperations,
    retryTurn,
    setProvider,
    providers,
  });
  latest.current = {
    copyText,
    regenerate,
    openDelegation,
    decideOperation,
    decideOperations,
    retryTurn,
    setProvider,
    providers,
  };
  const actions = useMemo<ChatActions>(
    () => ({
      copy: (text) => void latest.current.copyText(text),
      regenerate: (turnId) => void latest.current.regenerate(turnId),
      delegate: (kind) => void latest.current.openDelegation(kind),
      decide: (id, decision) => void latest.current.decideOperation(id, decision),
      decideMany: (ids, decision) => void latest.current.decideOperations(ids, decision),
      retry: (turn) => void latest.current.retryTurn(turn),
      retryOther: (turn) => {
        latest.current.setProvider("auto");
        void latest.current.retryTurn(turn);
      },
      refreshHealth: () => void latest.current.providers.reloadFresh(),
    }),
    [],
  );

  const usage = detail?.conversation.usage as
    | { cost_usd?: number | null; input_tokens?: number | null; output_tokens?: number | null }
    | undefined;

  return (
    <div className={`chat-page${sideOpen ? "" : " is-side-collapsed"}`}>
      <aside className="chat-side" aria-label={t("chat.list")} hidden={!sideOpen}>
        <div className="chat-side-head">
          <div className="row">
            <h2>{t("nav.chat")}</h2>
            <button
              type="button"
              className="sm"
              onClick={() => void createChat()}
              aria-label={t("chat.new")}
            >
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
                <div key={c.id} className={`chat-item${activeId === c.id ? " is-active" : ""}`}>
                  <a
                    className="chat-item-link"
                    href={`#/chat/${c.id}`}
                    aria-current={activeId === c.id ? "page" : undefined}
                  >
                    <span className="chat-item-title" title={c.title || t("chat.untitled")}>
                      {c.title || t("chat.untitled")}
                    </span>
                    {c.active_turn ? (
                      <span className="chat-item-live">{t("chat.live.badge")}</span>
                    ) : null}
                  </a>
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
            type="button"
            className="ghost icon sm"
            onClick={() => setSideOpen((v) => !v)}
            aria-label={sideOpen ? t("chat.hideList") : t("chat.showList")}
          >
            {sideOpen ? <ChevronLeft size={16} /> : <PanelLeft size={16} />}
          </button>
          <div className="chat-title">{detail?.conversation.title || t("chat.untitled")}</div>
          <button type="button" className="ghost sm" onClick={() => setMemoryOpen(true)}>
            {t("chat.memory")}
          </button>
          {detail && (
            <>
              <button
                type="button"
                className="ghost sm"
                onClick={() => void patchConversation({ archived: true })}
                aria-label={t("chat.archive")}
              >
                <Archive size={15} />
              </button>
              <button
                type="button"
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
            <button type="button" onClick={() => void createChat()}>
              {t("chat.new")}
            </button>
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
                <ChatMessages
                  messages={detail.messages}
                  turnsById={turnsById}
                  toolsByTurn={toolsByTurn}
                  opsByTurn={opsByTurn}
                  hasActiveTurn={!!detail.active_turn}
                  actions={actions}
                  t={t}
                />

                {imports.map((im) => (
                  <ChatImportReview
                    key={im.id}
                    scope={im.scope}
                    proposals={im.proposals}
                    errors={im.errors}
                  />
                ))}
                <Operations
                  ops={opsByTurn.get(null) ?? []}
                  onDecide={(id, d) => void decideOperation(id, d)}
                  onDecideMany={(ids, d) => void decideOperations(ids, d)}
                />

                {visiblePending.map((p) => (
                  <div key={p.cid} className="chat-block">
                    <article
                      className={`chat-bubble is-user is-pending${p.status === "failed" ? " is-failed" : ""}`}
                    >
                      <div className="chat-bubble-meta">
                        <span>{t("chat.role.user")}</span>
                        <span>
                          {p.status === "sending" ? t("chat.sending") : t("chat.sendFailed")}
                        </span>
                      </div>
                      <div style={{ whiteSpace: "pre-wrap" }}>{p.content}</div>
                      <Thumbs
                        items={(p.images ?? []).map((i) => ({ key: i.url, src: i.url }))}
                        label={t("chat.attach.open")}
                      />
                      <DocChips
                        items={(p.documents ?? []).map((f, i) => ({
                          key: i,
                          name: f.name,
                          bytes: f.size,
                          state:
                            p.status === "failed"
                              ? t("chat.sendFailed")
                              : p.attachmentIds
                                ? t("chat.attach.uploaded")
                                : t("chat.attach.uploading"),
                        }))}
                      />
                    </article>
                    {p.status === "failed" && (
                      <div className="chat-failure" role="alert">
                        <AlertTriangle size={16} />
                        <div>
                          <div>{p.error}</div>
                          <div className="chat-failure-actions">
                            <button
                              type="button"
                              className="sm"
                              onClick={() => retrySend(p)}
                              disabled={busy || !!detail.active_turn}
                            >
                              {t("chat.retry")}
                            </button>
                            <button
                              type="button"
                              className="ghost sm"
                              onClick={() =>
                                setPending((all) => all.filter((x) => x.cid !== p.cid))
                              }
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
                          {[
                            detail.active_turn?.provider,
                            detail.active_turn?.model,
                            detail.active_turn?.route,
                          ]
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
                      {!!live?.text && !live.held && <Markdown text={live.text} />}
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
                    .filter(
                      (p) =>
                        p.id === "auto" ||
                        (p.enabled && p.ok && p.quota !== "exhausted") ||
                        p.id === provider,
                    )
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
                  type="button"
                  className={`ghost sm${advanced ? " on" : ""}`}
                  aria-label={t("chat.provider")}
                  onClick={() => setAdvanced((v) => !v)}
                  aria-expanded={advanced}
                >
                  <Settings2 size={15} />
                  <ChevronRight
                    size={14}
                    style={{ transform: advanced ? "rotate(90deg)" : undefined }}
                  />
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept={[
                    ...IMAGE_TYPES,
                    ".pdf",
                    ".docx",
                    ".xlsx",
                    ".md",
                    ".markdown",
                    ".txt",
                    ".json",
                    ".csv",
                  ].join(",")}
                  multiple
                  hidden
                  onChange={(e) => {
                    addImages(Array.from(e.target.files ?? []));
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className="ghost sm"
                  title={t("chat.attach")}
                  onClick={() => fileInput.current?.click()}
                  disabled={
                    !!detail.active_turn ||
                    (images.length >= IMAGES_PER_MESSAGE &&
                      documents.length >= DOCUMENTS_PER_MESSAGE)
                  }
                >
                  <Paperclip size={15} /> {t("chat.attach.short")}
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
              {activeId != null && (
                <ChatDelegations conversationId={activeId} version={runsVersion} />
              )}
              {proposal && (
                <div className="chat-proposal" role="status">
                  <Workflow size={15} />
                  <span>{t("chat.proposal", { title: proposal.title })}</span>
                  <button
                    type="button"
                    className="sm"
                    onClick={() => void openDelegation(proposal)}
                  >
                    {t("chat.proposal.review")}
                  </button>
                </div>
              )}
              <DocChips
                items={documents.map((f, i) => ({ key: i, name: f.name, bytes: f.size }))}
                onRemove={(key) => setDocuments((cur) => cur.filter((_, i) => i !== key))}
                removeLabel={t("chat.attach.remove")}
              />
              {images.length > 0 && (
                <div className="chat-thumbs is-composer">
                  {images.map((i) => (
                    <span key={i.url} className="chat-thumb">
                      <img src={i.url} alt="" />
                      <button
                        type="button"
                        className="ghost xs"
                        aria-label={t("chat.attach.remove")}
                        title={t("chat.attach.remove")}
                        onClick={() => removeImage(i.url)}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                value={draft}
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData.files).filter(
                    (f) => isImage(f) || isDocument(f),
                  );
                  const text = e.clipboardData.getData("text");
                  if (!files.length && text.length > PASTE_AS_FILE_CHARS) {
                    e.preventDefault();
                    const stamp = new Date().toTimeString().slice(0, 8).replaceAll(":", "");
                    addImages([
                      new File([text], `pasted-text-${stamp}.txt`, { type: "text/plain" }),
                    ]);
                    return;
                  }
                  if (!files.length) return;
                  // A pasted screenshot is an attachment; pasted text keeps its default behaviour.
                  if (!e.clipboardData.getData("text")) e.preventDefault();
                  addImages(files);
                }}
                onDragOver={(e) => {
                  if (Array.from(e.dataTransfer.items).some((i) => i.kind === "file"))
                    e.preventDefault();
                }}
                onDrop={(e) => {
                  const files = Array.from(e.dataTransfer.files).filter(
                    (f) => isImage(f) || isDocument(f),
                  );
                  if (!files.length) return;
                  e.preventDefault();
                  addImages(files);
                }}
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
                        cost:
                          usage.cost_usd == null ? "—" : `$${Number(usage.cost_usd).toFixed(4)}`,
                        tokens:
                          usage.input_tokens == null && usage.output_tokens == null
                            ? "—"
                            : `${usage.input_tokens ?? "—"}/${usage.output_tokens ?? "—"}`,
                      })}
                    </>
                  )}
                </span>
                {detail.active_turn ? (
                  <button type="button" className="warn" onClick={() => void cancel()}>
                    <Square size={15} /> {t("chat.stop")}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void send()}
                    disabled={(!draft.trim() && !images.length && !documents.length) || busy}
                  >
                    <Send size={15} /> {t("chat.send")}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </section>

      {memoryOpen && (
        <Drawer title={t("chat.memory")} onClose={() => setMemoryOpen(false)}>
          <div className="chat-modal-card">
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
                    <button
                      type="button"
                      className="ghost xs"
                      onClick={() => void updateMemory(m.key, { enabled: !m.enabled })}
                    >
                      {m.enabled ? t("chat.memory.disable") : t("chat.memory.enable")}
                    </button>
                    <button
                      type="button"
                      className="ghost xs"
                      onClick={async () => {
                        const content = await dialog.prompt({
                          title: t("chat.memory.edit"),
                          defaultValue: m.content,
                        });
                        if (content && content.trim() !== m.content)
                          void updateMemory(m.key, { content: content.trim() });
                      }}
                    >
                      {t("chat.memory.edit")}
                    </button>
                    <button
                      type="button"
                      className="ghost xs danger"
                      onClick={() => void deleteMemory(m.key)}
                    >
                      {t("chat.memory.delete")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="chat-failure-actions">
              <button type="button" className="ghost sm" onClick={() => setMemoryOpen(false)}>
                {t("common.close")}
              </button>
            </div>
          </div>
        </Drawer>
      )}

      {preview && (
        <Drawer title={t("chat.preview")} onClose={() => setPreview(null)}>
          <div className="chat-modal-card">
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
              <button type="button" className="ghost" onClick={() => setPreview(null)}>
                {t("chat.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void confirmDelegation()}
                disabled={!preview.workflow}
              >
                {t("chat.confirmDelegate")}
              </button>
            </div>
          </div>
        </Drawer>
      )}
    </div>
  );
}
