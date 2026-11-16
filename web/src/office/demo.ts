import { useEffect, useRef, useState } from "react";
import { ROLE_INFO } from "./workflowToAgentMapper.ts";
import { useI18n } from "../i18n/index.tsx";
import type {
  AttemptLite,
  EventLite,
  GraphStepLite,
  OfficeSnapshot,
  QuestionLite,
  StepLite,
} from "./types.ts";

/**
 * PREVIEW OFFICE — local mock data only. Never calls the API, never creates runs, never runs Claude.
 * A scripted tour through every status and activity, fed through the same mapper as real runs.
 */

const GRAPH: GraphStepLite[] = [
  { key: "analyze", type: "agent", name: "Requirement Analysis" },
  {
    key: "discover",
    type: "integration",
    name: "Repository Discovery",
    depends_on: ["analyze"],
  },
  {
    key: "plan",
    type: "agent",
    name: "Architecture & Plan",
    depends_on: ["discover"],
  },
  {
    key: "approve_plan",
    type: "human_approval",
    name: "Approve Plan",
    depends_on: ["plan"],
  },
  {
    key: "implement",
    type: "coding_agent",
    name: "Implementation",
    depends_on: ["approve_plan"],
  },
  { key: "test", type: "command", name: "Testing", depends_on: ["implement"] },
  { key: "review", type: "agent", name: "Code Review", depends_on: ["test"] },
  {
    key: "pr",
    type: "git_pull_request",
    name: "Pull Request",
    depends_on: ["review"],
  },
];

type Ev = { kind: string; name?: string; input?: any; content?: string };
interface Frame {
  caption: string;
  status: Record<string, string>;
  events?: Record<string, Ev[]>;
  questions?: string[];
  errors?: Record<string, string>;
}

const P = "PENDING",
  RUN = "RUNNING",
  OK = "COMPLETED";
const all = (s: string) => Object.fromEntries(GRAPH.map((g) => [g.key, s]));
const FRAMES: Frame[] = [
  { caption: "office.cap.quiet", status: all(P) },
  {
    caption: "office.cap.read",
    status: { ...all(P), analyze: RUN },
    events: {
      analyze: [
        {
          kind: "tool",
          name: "Read",
          input: { file_path: "docs/requirements/payment-refund.md" },
        },
      ],
    },
  },
  {
    caption: "office.cap.grep",
    status: { ...all(P), analyze: RUN },
    events: {
      analyze: [
        { kind: "tool", name: "Grep", input: { pattern: "RefundShipment" } },
      ],
    },
  },
  {
    caption: "office.cap.think",
    status: { ...all(P), analyze: RUN },
    events: { analyze: [{ kind: "thinking", content: "…" }] },
  },
  {
    caption: "office.cap.ask",
    status: { ...all(P), analyze: "WAITING_INPUT" },
    questions: ["analyze", "analyze"],
  },
  {
    caption: "office.cap.discover",
    status: { ...all(P), analyze: OK, discover: RUN },
  },
  {
    caption: "office.cap.done",
    status: { ...all(P), analyze: OK, discover: OK },
  },
  {
    caption: "office.cap.plan",
    status: { ...all(P), analyze: OK, discover: OK, plan: RUN },
  },
  {
    caption: "office.cap.skill",
    status: { ...all(P), analyze: OK, discover: OK, plan: RUN },
    events: {
      plan: [
        {
          kind: "tool",
          name: "mcp__platform__read_knowledge",
          input: { key: "oms-money-model" },
        },
      ],
    },
  },
  {
    caption: "office.cap.approve",
    status: {
      ...all(P),
      analyze: OK,
      discover: OK,
      plan: OK,
      approve_plan: "WAITING_APPROVAL",
    },
  },
  {
    caption: "office.cap.edit",
    status: { ...all(OK), implement: RUN, test: P, review: P, pr: P },
    events: {
      implement: [
        {
          kind: "tool",
          name: "Edit",
          input: { file_path: "app/usecases/payment_refund.go" },
        },
      ],
    },
  },
  {
    caption: "office.cap.bash",
    status: { ...all(OK), implement: RUN, test: P, review: P, pr: P },
    events: {
      implement: [
        { kind: "tool", name: "Bash", input: { command: "go build ./..." } },
      ],
    },
  },
  {
    caption: "office.cap.commit",
    status: { ...all(OK), implement: RUN, test: P, review: P, pr: P },
    events: {
      implement: [
        {
          kind: "tool",
          name: "Bash",
          input: { command: "git commit -q -F -" },
        },
      ],
    },
  },
  {
    caption: "office.cap.test",
    status: { ...all(OK), implement: OK, test: RUN, review: P, pr: P },
    events: {
      test: [{ kind: "output", content: "== go test -short ./app/usecases" }],
    },
  },
  {
    caption: "office.cap.fail",
    status: { ...all(OK), implement: OK, test: "FAILED", review: P, pr: P },
    errors: { test: "Test_parseCreateItem_missing failed" },
  },
  {
    caption: "office.cap.retry",
    status: { ...all(OK), implement: OK, test: "RETRYING", review: P, pr: P },
    events: {
      test: [
        { kind: "output", content: "== go test -short ./app/usecases (retry)" },
      ],
    },
  },
  {
    caption: "office.cap.review",
    status: { ...all(OK), review: RUN, pr: P },
    events: {
      review: [
        {
          kind: "tool",
          name: "Bash",
          input: { command: "git diff origin/release/prod...HEAD" },
        },
      ],
    },
  },
  { caption: "office.cap.pr", status: { ...all(OK), pr: RUN } },
  { caption: "office.cap.finish", status: all(OK) },
  {
    caption: "office.cap.gallery",
    status: {
      analyze: "READY",
      discover: P,
      plan: "SKIPPED",
      approve_plan: "SKIPPED",
      implement: "CANCELED",
      test: "FAILED",
      review: "WAITING_APPROVAL",
      pr: "RETRYING",
    },
    errors: { test: "go test: 3 regressions" },
  },
];
const FRAME_MS = 3800;

export function usePreviewOffice(enabled: boolean) {
  const { t } = useI18n();
  const [i, setI] = useState(0);
  const times = useRef<{
    started: Record<string, number>;
    finished: Record<string, number>;
    events: Record<string, EventLite[]>;
    seq: number;
  }>({ started: {}, finished: {}, events: {}, seq: 1 });
  useEffect(() => {
    if (!enabled) return;
    setI(0);
    times.current = { started: {}, finished: {}, events: {}, seq: 1 };
    const t = setInterval(() => setI((n) => (n + 1) % FRAMES.length), FRAME_MS);
    return () => clearInterval(t);
  }, [enabled]);

  const frame = FRAMES[i];
  const now = Date.now();
  const tm = times.current;
  const steps: StepLite[] = GRAPH.map((g, idx) => ({
    key: g.key,
    name: g.name!,
    type: g.type,
    status: frame.status[g.key],
    current_attempt_id: frame.status[g.key] === P ? null : 9000 + idx,
    position: idx,
  }));
  for (const s of steps) {
    const active = [
      "RUNNING",
      "RETRYING",
      "WAITING_INPUT",
      "WAITING_APPROVAL",
      "READY",
    ].includes(s.status);
    if (active && !tm.started[s.key]) tm.started[s.key] = now;
    if (s.status === P) (delete tm.started[s.key], delete tm.finished[s.key]);
    if (
      ["COMPLETED", "FAILED", "CANCELED", "SKIPPED"].includes(s.status) &&
      !tm.finished[s.key]
    )
      tm.finished[s.key] = now;
    if (!["COMPLETED", "FAILED", "CANCELED", "SKIPPED"].includes(s.status))
      delete tm.finished[s.key];
    for (const e of frame.events?.[s.key] ?? []) {
      const list = (tm.events[s.key] ??= []);
      if (list.at(-1)?.content === `${i}:${e.name ?? e.kind}`) continue;
      list.push({
        id: tm.seq++,
        kind: e.kind,
        content: e.content ?? `${i}:${e.name ?? e.kind}`,
        data: e.name ? { name: e.name, input: e.input } : undefined,
        created_at: new Date(now).toISOString(),
      });
    }
  }
  const attempts: AttemptLite[] = steps
    .filter((s) => s.current_attempt_id)
    .map((s) => ({
      id: s.current_attempt_id!,
      step_key: s.key,
      number: s.status === "RETRYING" ? 2 : 1,
      status: s.status,
      started_at: tm.started[s.key]
        ? new Date(tm.started[s.key]).toISOString()
        : new Date(now - 60000).toISOString(),
      finished_at: tm.finished[s.key]
        ? new Date(tm.finished[s.key]).toISOString()
        : null,
      error: frame.errors?.[s.key] ?? null,
    }));
  const questions: QuestionLite[] = (frame.questions ?? []).map((k) => ({
    step_key: k,
    status: "open",
  }));
  const events = Object.fromEntries(
    steps
      .filter((s) => s.current_attempt_id)
      .map((s) => [s.current_attempt_id!, tm.events[s.key] ?? []]),
  );
  const snapshot: OfficeSnapshot = {
    run: { id: 0, title: t("office.previewTitle"), status: "PREVIEW" },
    steps,
    graph: GRAPH,
    attempts,
    questions,
    events,
  };
  const caption = t(frame.caption).replace(
    /\{(\w+)\}/g,
    (_, r) => ROLE_INFO[r as keyof typeof ROLE_INFO]?.name ?? r,
  );
  return { snapshot, caption, frame: i, frames: FRAMES.length };
}
