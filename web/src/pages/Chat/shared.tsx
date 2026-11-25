import { useState } from "react";
import { FileText, X } from "lucide-react";
import { useI18n } from "../../i18n/index.tsx";
import { type TraceItem } from "../chatStream.ts";
import { splitOperations } from "../chatOperationBatch.ts";

export type Mode = "AUTO" | "ASK" | "INVESTIGATE" | "PLAN" | "DELEGATE";

export type Conversation = {
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

export type DateGroupKey = "today" | "yesterday" | "week" | "older";

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function dateGroupKey(iso: string, now = new Date()): DateGroupKey {
  const t = startOfDay(new Date(iso));
  const today = startOfDay(now);
  const day = 86_400_000;
  if (t === today) return "today";
  if (t === today - day) return "yesterday";
  if (t > today - 7 * day) return "week";
  return "older";
}

export type Message = {
  id: number;
  turn_id: number | null;
  role: "user" | "assistant" | "system";
  content: string;
  citations?: Array<{ label: string; tool?: string; ref: string; repository?: string }>;
  withheld?: boolean;
  attachments?: Array<{
    id: number;
    media_type: string;
    bytes: number;
    kind?: "image" | "document";
    filename?: string;
  }>;
  created_at: string;
};

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** Documents the server can read; the server checks the bytes again (the extension only pre-filters here). */
export const DOCUMENT_EXT = /\.(pdf|docx|xlsx|md|markdown|txt|json|csv)$/i;

export const isImage = (f: File) => IMAGE_TYPES.includes(f.type);

const sizeLabel = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

const typeLabel = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "file").toUpperCase();

/** Document chips (name, type, size); in history each downloads through the authenticated route. */
export function DocChips({
  items,
  onRemove,
  removeLabel,
}: {
  items: Array<{
    key: string | number;
    name: string;
    bytes: number;
    href?: string;
    state?: string;
  }>;
  onRemove?: (key: string | number) => void;
  removeLabel?: string;
}) {
  if (!items.length) return null;
  return (
    <div className="chat-docs">
      {items.map((d) => (
        <span key={d.key} className="chat-doc">
          <FileText size={14} />
          {d.href ? (
            <a href={d.href} download={d.name}>
              {d.name}
            </a>
          ) : (
            <span>{d.name}</span>
          )}
          <small>
            {typeLabel(d.name)} · {sizeLabel(d.bytes)}
            {d.state ? ` · ${d.state}` : ""}
          </small>
          {onRemove && (
            <button
              type="button"
              className="ghost xs"
              aria-label={removeLabel}
              title={removeLabel}
              onClick={() => onRemove(d.key)}
            >
              <X size={12} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

/** Thumbnails of a message's images; each opens the original through the authenticated route. */
export function Thumbs({
  items,
  label,
}: {
  items: Array<{ key: string | number; src: string }>;
  label: string;
}) {
  if (!items.length) return null;
  return (
    <div className="chat-thumbs">
      {items.map((i) => (
        <a
          key={i.key}
          href={i.src}
          target="_blank"
          rel="noopener noreferrer"
          title={label}
          aria-label={label}
        >
          <img src={i.src} alt="" loading="lazy" />
        </a>
      ))}
    </div>
  );
}

export type ToolCall = {
  id: number;
  turn_id: number;
  seq: number;
  tool: string;
  status: string;
  duration_ms: number | null;
  result?: unknown;
};

export type Turn = {
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

export type Operation = {
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

export type T = (k: string, p?: Record<string, string | number>) => string;

function OperationCard({
  op,
  onDecide,
}: {
  op: Operation;
  onDecide: (id: number, d: "confirm" | "reject") => void;
}) {
  const { t } = useI18n();
  const target = Object.values(op.target ?? {})
    .filter(Boolean)
    .join(" / ");
  return (
    <div
      className={`chat-operation is-${op.status}`}
      role={op.status === "pending" ? "alert" : undefined}
    >
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
          <button type="button" className="sm" onClick={() => onDecide(op.id, "confirm")}>
            {t("chat.op.confirm")}
          </button>
          <button type="button" className="ghost sm" onClick={() => onDecide(op.id, "reject")}>
            {t("chat.op.reject")}
          </button>
          <span className="muted">
            {t("chat.op.expires", { at: new Date(op.expires_at).toLocaleTimeString() })}
          </span>
        </div>
      )}
    </div>
  );
}

function OperationBatchCard({
  ops,
  onDecideMany,
}: {
  ops: Operation[];
  onDecideMany: (ids: number[], d: "confirm" | "reject") => void;
}) {
  const { t } = useI18n();
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const chosen = ops.filter((o) => !skipped.has(o.id)).map((o) => o.id);
  const toggle = (id: number) =>
    setSkipped((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <div className="chat-operation is-pending" role="alert">
      <div className="chat-operation-head">
        <strong>{t("chat.op.batch.title", { n: ops.length })}</strong>
      </div>
      {ops.map((op) => (
        <label key={op.id} className="chat-operation-choice">
          <input type="checkbox" checked={!skipped.has(op.id)} onChange={() => toggle(op.id)} />{" "}
          <strong>#{op.id}</strong> {op.tool}{" "}
          <span className="muted">
            {Object.values(op.target ?? {})
              .filter(Boolean)
              .join(" / ")}
          </span>
        </label>
      ))}
      <div className="chat-failure-actions">
        <button
          type="button"
          className="sm"
          disabled={!chosen.length}
          onClick={() => onDecideMany(chosen, "confirm")}
        >
          {t("chat.op.batch.confirm", { n: chosen.length })}
        </button>
        <button
          type="button"
          className="ghost sm"
          disabled={!chosen.length}
          onClick={() => onDecideMany(chosen, "reject")}
        >
          {t("chat.op.batch.reject", { n: chosen.length })}
        </button>
      </div>
    </div>
  );
}

export function Operations({
  ops,
  onDecide,
  onDecideMany,
}: {
  ops: Operation[];
  onDecide: (id: number, d: "confirm" | "reject") => void;
  onDecideMany: (ids: number[], d: "confirm" | "reject") => void;
}) {
  const { batch, rest } = splitOperations(ops);
  return (
    <>
      {batch.length > 0 && <OperationBatchCard ops={batch} onDecideMany={onDecideMany} />}
      {rest.map((op) => (
        <OperationCard key={op.id} op={op} onDecide={onDecide} />
      ))}
    </>
  );
}

export function traceSummary(turn: Turn | undefined, t: T) {
  const steps = (turn?.trace ?? []).filter((i) => i.k !== "reasoning").length;
  const ms =
    turn?.started_at && turn.finished_at
      ? Date.parse(turn.finished_at) - Date.parse(turn.started_at)
      : null;
  return t("chat.reasoning.done", {
    s: ms != null ? Math.max(1, Math.round(ms / 1000)) : "?",
    n: steps,
  });
}

export type ChatActions = {
  copy: (text: string) => void;
  regenerate: (turnId: number) => void;
  delegate: (kind: "task" | "delegate" | "investigation") => void;
  decide: (id: number, decision: "confirm" | "reject") => void;
  decideMany: (ids: number[], decision: "confirm" | "reject") => void;
  retry: (turn: Turn) => void;
  retryOther: (turn: Turn) => void;
  refreshHealth: () => void;
};
