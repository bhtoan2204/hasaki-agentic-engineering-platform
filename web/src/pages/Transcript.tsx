import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { agentKey, type AgentProvider } from "../agentProvider.tsx";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Brain,
  CheckCircle2,
  CornerDownLeft,
  FolderSearch,
  Layers,
  ListFilter,
  MessageSquare,
  Pencil,
  ScrollText,
  Send,
  SquareTerminal,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { api } from "../api.ts";
import { Badge, Copy, dur, ago, Markdown, time } from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";
import "./RunView.css";

interface Ev {
  id: number;
  kind: string;
  content: string;
  data: any;
  created_at: string;
}

const FILTERS = [
  "all",
  "messages",
  "tools",
  "read",
  "modified",
  "commands",
  "errors",
  "reasoning",
  "prompts",
] as const;
type Filter = (typeof FILTERS)[number];
const FILTER_ICON: Record<Filter, LucideIcon> = {
  all: Layers,
  messages: MessageSquare,
  tools: Wrench,
  read: FolderSearch,
  modified: Pencil,
  commands: SquareTerminal,
  errors: AlertTriangle,
  reasoning: Brain,
  prompts: ArrowRight,
};
const Av = ({ icon: I }: { icon: LucideIcon }) => (
  <span className="tr-av" aria-hidden>
    <I size={13} strokeWidth={2.2} />
  </span>
);

const READ_TOOLS = ["Read", "Grep", "Glob", "LS"];
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

function toolIcon(name: string): LucideIcon {
  return READ_TOOLS.includes(name)
    ? FolderSearch
    : EDIT_TOOLS.includes(name)
      ? Pencil
      : name === "Bash" || name === "run_command" || name === "exec_command"
        ? SquareTerminal
        : Wrench;
}

function StatTile({
  icon: I,
  n,
  label,
  children,
}: {
  icon: LucideIcon;
  n: ReactNode;
  label: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="tr-stat">
      <div className="tr-stat-top">
        <I size={14} />
        <b>{n}</b>
        {label}
      </div>
      {children}
    </div>
  );
}

function toolName(data: any): string {
  return String(data?.name ?? data?.tool ?? "");
}

function toolHint(input: any = {}) {
  const args = input.args && typeof input.args === "object" ? input.args : {};
  return String(
    input.file_path ??
      input.notebook_path ??
      input.path ??
      input.pattern ??
      input.command ??
      args.command ??
      args.CommandLine ??
      args.cmd ??
      input.repo ??
      input.url ??
      input.query ??
      input.description ??
      input.step_key ??
      "",
  ).split("\n")[0];
}

/** Token deltas were stored as separate rows. Show one message until a tool or another kind interrupts. */
export function coalesceStream<T extends { kind: string; content: string }>(events: T[]): T[] {
  const out: T[] = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (prev && (e.kind === "agent" || e.kind === "thinking") && prev.kind === e.kind) {
      out[out.length - 1] = { ...prev, content: prev.content + e.content };
      continue;
    }
    out.push(e);
  }
  return out;
}

/**
 * Claude Code execution viewer for one attempt: streamed from the backend (SSE-triggered incremental fetches of
 * /api/attempts/:id/transcript). Shows only what the SDK returned; "reasoning" is the summarised thinking the API exposes.
 */
export function Transcript({
  attemptId,
  live,
  tick,
  provider = "claude",
}: {
  attemptId: number;
  live: boolean;
  tick: number;
  provider?: AgentProvider;
}) {
  const { t } = useI18n();
  const agent = t(agentKey(provider, true));
  const [events, setEvents] = useState<Ev[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [follow, setFollow] = useState(true);
  const last = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEvents([]);
    last.current = 0;
  }, [attemptId]);
  useEffect(() => {
    let stop = false;
    api<Ev[]>(`/api/attempts/${attemptId}/transcript?after=${last.current}`).then((rows) => {
      if (stop || !rows.length) return;
      last.current = rows[rows.length - 1].id;
      setEvents((prev) => [...prev, ...rows]);
    });
    return () => {
      stop = true;
    };
  }, [attemptId, tick]);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [events, follow, filter]);

  const stream = useMemo(() => coalesceStream(events), [events]);
  const results = useMemo(() => {
    const m: Record<string, Ev> = {};
    for (const e of events)
      if (e.kind === "tool_result" && e.data?.tool_use_id) m[e.data.tool_use_id] = e;
    return m;
  }, [events]);
  const tools = stream.filter((e) => e.kind === "tool" && toolName(e.data));
  const filesRead = [
    ...new Set(
      tools
        .filter((e) => READ_TOOLS.includes(toolName(e.data)))
        .map((e) => toolHint(e.data.input ?? e.data.args)),
    ),
  ];
  const filesModified = [
    ...new Set(
      tools
        .filter((e) => EDIT_TOOLS.includes(toolName(e.data)))
        .map((e) => toolHint(e.data.input ?? e.data.args)),
    ),
  ];
  const commands = tools.filter((e) =>
    ["Bash", "run_command", "exec_command"].includes(toolName(e.data)),
  );
  const errors = events.filter(
    (e) =>
      (e.kind === "tool_result" && e.data?.is_error) ||
      (e.kind === "tool" && !e.data?.name && e.content.startsWith("denied")) ||
      (e.kind === "result" && e.data?.is_error),
  );
  const result = [...events].reverse().find((e) => e.kind === "result");

  const visible = stream.filter((e) => {
    const name = toolName(e.data);
    switch (filter) {
      case "all":
        return (
          e.kind !== "tool_result" ||
          !e.data?.tool_use_id ||
          !tools.some((t) => t.data.id === e.data.tool_use_id)
        );
      case "messages":
        return e.kind === "agent" || e.kind === "result";
      case "tools":
        return e.kind === "tool";
      case "read":
        return e.kind === "tool" && READ_TOOLS.includes(name);
      case "modified":
        return e.kind === "tool" && EDIT_TOOLS.includes(name);
      case "commands":
        return e.kind === "tool" && ["Bash", "run_command", "exec_command"].includes(name);
      case "errors":
        return errors.includes(e) || (e.kind === "tool" && results[e.data?.id]?.data?.is_error);
      case "reasoning":
        return e.kind === "thinking";
      case "prompts":
        return e.kind === "prompt" || e.kind === "system_prompt";
    }
  });

  return (
    <div>
      <div className="tr-stats">
        <StatTile icon={FolderSearch} n={filesRead.length} label={t("tr.filesRead")}>
          <div className="mono" title={filesRead.join("\n")}>
            {filesRead.map((f) => (
              <div key={f}>{f}</div>
            ))}
          </div>
        </StatTile>
        <StatTile icon={Pencil} n={filesModified.length} label={t("tr.filesModified")}>
          <div className="mono" title={filesModified.join("\n")}>
            {filesModified.map((f) => (
              <div key={f}>{f}</div>
            ))}
          </div>
        </StatTile>
        <StatTile
          icon={SquareTerminal}
          n={commands.length}
          label={
            <>
              {t("tr.commands")} ·{" "}
              <b className={errors.length ? "err" : ""} style={{ fontSize: "inherit" }}>
                {errors.length}
              </b>{" "}
              {t("tr.errors")}
            </>
          }
        >
          {result && (
            <div className="muted small" style={{ marginTop: 4 }}>
              {t("tr.turns", { n: result.data?.num_turns })} · {dur(result.data?.duration_ms)}
              {result.data?.total_cost_usd != null &&
                ` · $${Number(result.data.total_cost_usd).toFixed(3)}`}
            </div>
          )}
        </StatTile>
      </div>
      <div className="tl-filters" role="group" aria-label={t("tr.filter")}>
        <ListFilter size={14} color="var(--muted)" aria-hidden />
        {FILTERS.map((k) => {
          const I = FILTER_ICON[k];
          return (
            <button
              key={k}
              className={filter === k ? "" : "ghost"}
              aria-pressed={filter === k}
              onClick={() => setFilter(k)}
            >
              <I size={12} />
              {t(`tr.f.${k}`)}
            </button>
          );
        })}
        <span className="grow" />
        <label
          className="small muted"
          style={{ display: "inline-flex", gap: 5, alignItems: "center" }}
        >
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />{" "}
          {t("tr.follow")}
        </label>
      </div>
      <div
        ref={box}
        className="tr-feed"
        onScroll={() => {
          if (!box.current) return;
          const isNearBottom =
            box.current.scrollHeight - box.current.scrollTop - box.current.clientHeight < 50;
          if (!isNearBottom && follow) setFollow(false);
          else if (isNearBottom && !follow) setFollow(true);
        }}
      >
        {visible.map((e) => (
          <Entry
            key={e.id}
            e={e}
            result={e.kind === "tool" ? results[e.data?.id] : undefined}
            live={live}
            agent={agent}
          />
        ))}
        {!events.length && <div className="muted small">{t("tr.empty")}</div>}
        {live && (
          <div className="msg live">
            <span className="spinner" /> {t("tr.working", { name: agent })}{" "}
            {events.length
              ? t("tr.last", { ago: ago(events[events.length - 1].created_at) })
              : t("tr.starting")}
          </div>
        )}
      </div>
    </div>
  );
}

function Entry({ e, result, live, agent }: { e: Ev; result?: Ev; live: boolean; agent: string }) {
  const { t } = useI18n();
  const sub = e.data?.parent ? " sub" : "";
  const when = <span>{time(e.created_at)}</span>;
  switch (e.kind) {
    case "system_prompt":
      return (
        <details className="msg reason">
          <summary>
            <Av icon={ScrollText} /> {t("tr.system", { tools: (e.data?.tools ?? []).join(", ") })}{" "}
            {e.data?.knowledge?.length
              ? t("tr.knowledge", { items: e.data.knowledge.join(", ") })
              : ""}
          </summary>
          <div className="row tight">
            <span className="grow" />
            <Copy text={e.content} label={t("tr.copyPrompt")} />
          </div>
          <div className="pre">{e.content}</div>
        </details>
      );
    case "prompt":
      return (
        <div className={"msg prompt" + sub}>
          <div className="who">
            <Av icon={Send} />
            <b>{t("tr.toAgent", { name: agent })}</b>{" "}
            {e.data?.resume_session && <Badge s="READY">{t("tr.resume")}</Badge>} {when}
            <span className="grow" />
            <Copy text={e.content} label={t("tr.copyPrompt")} />
          </div>
          {e.content.length > 2500 ? (
            <details>
              <summary>
                {e.content.slice(0, 160)}… ({t("tr.chars", { n: e.content.length })})
              </summary>
              <div className="pre">{e.content}</div>
            </details>
          ) : (
            <div className="pre">{e.content}</div>
          )}
        </div>
      );
    case "agent":
      return (
        <div className={"msg claude" + sub}>
          <div className="who">
            <Av icon={Bot} />
            <b>{agent}</b> {when}
            <span className="grow" />
            <Copy text={e.content} />
          </div>
          <Markdown text={e.content} />
        </div>
      );
    case "thinking":
      return (
        <details className={"msg reason" + sub}>
          <summary>
            <Av icon={Brain} /> {t("tr.reasoning")} {when}
          </summary>
          <div className="pre">{e.content}</div>
        </details>
      );
    case "tool": {
      const name = toolName(e.data);
      if (!name)
        return (
          <div className={"msg note" + sub}>
            {when} {e.content}
          </div>
        );
      const err = result?.data?.is_error;
      const TI = toolIcon(name);
      return (
        <div className={"msg tool" + sub + (err ? " toolerr" : "")}>
          <div className="who">
            <Av icon={TI} />
            <b>{name.replace(/^mcp__platform__/, "platform·")}</b>
            <span className="mono">{toolHint(e.data.input ?? e.data.args).slice(0, 160)}</span>
            {when}
            {err && <Badge s="FAILED">{t("common.error")}</Badge>}
            {!result && live && <Badge s="RUNNING">{t("tr.running")}</Badge>}
          </div>
          <details>
            <summary>{t("tr.input")}</summary>
            <pre>{JSON.stringify(e.data.input ?? e.data.args ?? {}, null, 2)}</pre>
          </details>
          {result && (
            <details open={err}>
              <summary>{t("tr.result", { n: result.content.length })}</summary>
              <div className="row tight">
                <span className="grow" />
                <Copy text={result.content} />
              </div>
              <pre className={err ? "err" : ""}>{result.content}</pre>
            </details>
          )}
        </div>
      );
    }
    case "tool_result":
      return (
        <details className={"msg tool" + sub}>
          <summary>
            <Av icon={CornerDownLeft} /> {t("tr.toolResult")} {when}
          </summary>
          <pre>{e.content}</pre>
        </details>
      );
    case "result": {
      const d = e.data ?? {};
      return (
        <div className={"msg done " + (d.is_error ? "bad" : "ok")}>
          {d.is_error ? (
            <XCircle size={15} color="var(--st-err)" />
          ) : (
            <CheckCircle2 size={15} color="var(--st-ok)" />
          )}
          <b>{t("tr.finished")}</b> · {t("tr.turns", { n: d.num_turns ?? "?" })} ·{" "}
          {dur(d.duration_ms)}
          {d.total_cost_usd != null && ` · $${Number(d.total_cost_usd).toFixed(3)}`}
          {d.usage &&
            ` · ${t("tr.tokens", { inn: d.usage.input_tokens ?? 0, out: d.usage.output_tokens ?? 0 })}`}{" "}
          <span className="muted small">{time(e.created_at)}</span>
        </div>
      );
    }
    default:
      return (
        <div className={"msg note" + sub}>
          {when} <b>{e.kind}</b> {e.content}
        </div>
      );
  }
}
