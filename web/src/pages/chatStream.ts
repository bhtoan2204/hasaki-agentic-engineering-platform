/** Client state of the turn being generated, rebuilt from chat stream events and the turn's checkpoint. */
export type TraceItem =
  | { k: "reasoning"; text: string }
  | { k: "activity"; label: string }
  | { k: "tool"; id: number; tool: string; status: string; ms?: number }
  | {
      k: "knowledge";
      key: string;
      version: number;
      title: string;
      disclosure: string;
      owner: string;
    };

export type LiveStatus = "thinking" | "reading" | "tools" | "generating" | null;

export type Delta = { key: string; offset: number; text: string };

export interface LiveTurn {
  turnId: number;
  /** attempt:step of the provider call the text belongs to; null when seeded from a checkpoint. */
  key: string | null;
  text: string;
  trace: TraceItem[];
  status: LiveStatus;
  /** Deltas that arrived past the end of `text` (missed events): applied once a checkpoint catches up. */
  pending: Delta[];
}

const READING = /read|search|list|get|grep|open|file|knowledge|repo/i;

export const emptyLive = (turnId: number): LiveTurn => ({
  turnId,
  key: null,
  text: "",
  trace: [],
  status: null,
  pending: [],
});

function applyDelta(l: LiveTurn, d: Delta): LiveTurn {
  if (l.key !== null && l.key !== d.key) l = { ...l, key: d.key, text: "", pending: [] };
  if (d.offset > l.text.length) return { ...l, pending: [...l.pending, d].slice(-200) };
  let text = l.text.slice(0, d.offset) + d.text;
  const rest: Delta[] = [];
  for (const p of l.pending)
    if (p.key !== d.key) continue;
    else if (p.offset <= text.length) text = text.slice(0, p.offset) + p.text;
    else rest.push(p);
  return { ...l, key: d.key, text, pending: rest, status: "generating" };
}

/** Pure reducer: returns the same object when the event does not concern the live turn. */
export function applyChatEvent(
  live: LiveTurn | null,
  ev: { kind: string; turn_id: number | null; data?: Record<string, unknown> },
): LiveTurn | null {
  if (ev.turn_id == null) return live;
  let l = live && live.turnId === ev.turn_id ? live : emptyLive(ev.turn_id);
  const d = ev.data ?? {};
  switch (ev.kind) {
    case "response.delta":
      return applyDelta(l, {
        key: `${d.attempt}:${d.step}`,
        offset: Number(d.offset ?? 0),
        text: String(d.text ?? ""),
      });
    case "reasoning.delta": {
      const text = String(d.text ?? "");
      const last = l.trace.at(-1);
      const trace =
        last?.k === "reasoning"
          ? [...l.trace.slice(0, -1), { ...last, text: last.text + text }]
          : [...l.trace, { k: "reasoning" as const, text }];
      return { ...l, trace, status: l.status === "generating" ? l.status : "thinking" };
    }
    case "provider.activity": {
      const label = String(d.label ?? "");
      return {
        ...l,
        trace: [...l.trace, { k: "activity", label }],
        status: READING.test(label) ? "reading" : "tools",
      };
    }
    case "tool.started": {
      const tool = String(d.tool ?? "");
      l = { ...l, text: "", key: null, pending: [] };
      return {
        ...l,
        trace: [...l.trace, { k: "tool", id: Number(d.tool_call_id), tool, status: "running" }],
        status: READING.test(tool) ? "reading" : "tools",
      };
    }
    case "tool.completed":
    case "tool.failed":
      return {
        ...l,
        trace: l.trace.map((t) =>
          t.k === "tool" && t.id === Number(d.tool_call_id)
            ? { ...t, status: String(d.status ?? ev.kind), ms: Number(d.duration_ms ?? 0) }
            : t,
        ),
      };
    case "knowledge.applied": {
      const items = Array.isArray(d.items) ? (d.items as Array<Record<string, unknown>>) : [];
      const known = new Set(
        l.trace.filter((t) => t.k === "knowledge").map((t) => (t as { key: string }).key),
      );
      const added: TraceItem[] = items
        .filter((i) => !known.has(String(i.key)))
        .map((i) => ({
          k: "knowledge",
          key: String(i.key),
          version: Number(i.version),
          title: String(i.title ?? i.key),
          disclosure: String(i.disclosure ?? "read"),
          owner: String(i.owner ?? "shared"),
        }));
      return { ...l, trace: [...l.trace, ...added] };
    }
    case "phase.updated":
      return d.phase === "calling_provider" ? { ...l, status: "thinking" } : live;
    case "provider.attempt_started":
      return { ...l, text: "", key: null, pending: [], status: "thinking" };
    default:
      return live;
  }
}

/** Adopt the server checkpoint when it is ahead of what this client has (reconnect, missed events). */
export function seedFromTurn(
  live: LiveTurn | null,
  turn: { id: number; draft?: string; trace?: TraceItem[] },
): LiveTurn {
  const l = live && live.turnId === turn.id ? live : emptyLive(turn.id);
  const draft = turn.draft ?? "";
  const trace = turn.trace ?? [];
  let next = l;
  if (trace.length > l.trace.length) next = { ...next, trace };
  if (draft.length > l.text.length) {
    next = { ...next, text: draft, key: null, status: next.status ?? "generating" };
    for (const p of next.pending)
      if (p.offset <= next.text.length) next = applyDelta({ ...next, key: p.key }, p);
  }
  return next;
}
