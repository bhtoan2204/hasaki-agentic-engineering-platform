import { type StepAgentConfig } from "../../StepAgentFields.tsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, CircleAlert, Layers, X, type LucideIcon } from "lucide-react";
import { WF_TYPE_ICON, WF_TYPE_TONE } from "../Workflows.tsx";
import { useI18n } from "../../i18n/index.tsx";

type HumanQuestion = { question: string; options?: string[] };

export type StepConfig = {
  instructions?: string;
  output_contract?: string;
  skills?: string[];
  knowledge?: string[];
  delegation?: { enabled?: boolean; agents?: string[] };
  agent?: StepAgentConfig;
  max_turns?: number;
  questions?: HumanQuestion[];
  message?: string;
  show_outputs?: string[];
  select_repositories?: boolean;
  auto_approve_unambiguous?: boolean;
  on_reject?: { reexecute?: string };
  action?: string;
  use_ai?: boolean;
  max_candidates?: number;
  title?: string;
  from?: string[];
  command?: string;
  timeout_seconds?: number;
  allow_failure?: boolean;
  path?: string;
  op?: string;
  value?: unknown;
  mode?: string;
  content_from?: string;
  [key: string]: unknown;
};

export type Step = {
  key: string;
  type: string;
  name?: string;
  depends_on: string[];
  config: StepConfig;
  run_if?: { step: string; path?: string; equals: unknown };
  requires_approval?: boolean;
  max_attempts?: number;
  retry_backoff_seconds?: number;
  ui?: { x: number; y: number };
};

export type Spec = {
  name: string;
  description?: string;
  feedback_step?: string;
  inputs?: unknown;
  knowledge?: string[];
  skills?: string[];
  steps: Step[];
};

export type WorkflowDef = {
  key: string;
  latest_version: number;
  draft_spec: Spec | null;
  versions: Array<{ version: number; spec: Spec; change_note: string; published_at: string }>;
};

export type KnowledgeOption = {
  key: string;
  title: string;
  category: string;
  enabled: boolean;
  scope_type: string;
  scope_ref: string;
};

export const STEP_TYPES = [
  "agent",
  "coding_agent",
  "human_input",
  "human_approval",
  "integration",
  "command",
  "condition",
  "git_pull_request",
  "task_result_report",
];

export const TYPE_LABEL: Record<string, string> = {
  agent: "AI agent (read-only)",
  coding_agent: "Coding agent",
  human_input: "Human input",
  human_approval: "Human approval",
  integration: "Integration",
  command: "Command",
  condition: "Condition",
  git_pull_request: "Pull request",
  task_result_report: "Task Result Report",
};

export const PALETTE_GROUPS: Array<[string, string[]]> = [
  ["agents", ["agent", "coding_agent"]],
  ["people", ["human_input", "human_approval"]],
  ["logic", ["condition", "command", "integration"]],
  ["handoff", ["git_pull_request", "task_result_report"]],
];

export const typeIcon = (t: string): LucideIcon => WF_TYPE_ICON[t] ?? Layers;

export const typeTone = (t: string) => `tone-${WF_TYPE_TONE[t] ?? "logic"}`;

export const DEFAULT_CONFIG: Record<string, StepConfig> = {
  agent: { instructions: "", output_contract: "{ summary }" },
  coding_agent: {
    instructions:
      "Implement the approved plan. Call prepare_branch per repository, edit only in the worktree, commit, then submit_result.",
    output_contract: "{ summary, pull_requests: { [repo]: { title, summary, decisions } } }",
  },
  human_input: { questions: [{ question: "", options: [] }] },
  human_approval: { message: "", show_outputs: [] },
  integration: {
    action: "repository_discovery",
    use_ai: true,
    max_candidates: 5,
  },
  command: { command: "echo ok", timeout_seconds: 600 },
  condition: { path: "upstream.step.output.field", op: "eq", value: true },
  git_pull_request: { mode: "approval", content_from: "" },
  task_result_report: {},
};

export function ancestors(steps: Step[], key: string) {
  const by = new Map(steps.map((s) => [s.key, s]));
  const out = new Set<string>();
  const stack = [...(by.get(key)?.depends_on ?? [])];
  while (stack.length) {
    const k = stack.pop()!;
    if (out.has(k)) continue;
    out.add(k);
    stack.push(...(by.get(k)?.depends_on ?? []));
  }
  return out;
}

export function ErrorsCard({
  errors,
  stepKeys,
  onPick,
}: {
  errors: string[];
  stepKeys: Set<string>;
  onPick: (k: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  return (
    <div className="wfe-errors" role="alert">
      <button
        type="button"
        className="wfe-errors-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <CircleAlert size={16} />
        <b>{t("wfe.invalid")}</b>
        <span className="count">{errors.length}</span>
        <span className="grow" />
        <ChevronDown size={15} className={open ? "wfe-rot" : ""} />
      </button>
      {open && (
        <ul>
          {errors.map((e) => {
            const keys = [
              ...new Set(
                [...e.matchAll(/"([a-z0-9_-]+)"/g)].map((m) => m[1]).filter((k) => stepKeys.has(k)),
              ),
            ];
            return (
              <li key={e}>
                <span>{e}</span>
                {keys.map((k) => (
                  <button type="button" key={k} className="xs ghost" onClick={() => onPick(k)}>
                    {t("wfe.pick", { key: k })}
                  </button>
                ))}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- forms

export function Section({
  icon: I,
  title,
  children,
  aside,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="wfe-sec">
      <div className="wfe-sec-head">
        <I size={14} strokeWidth={2} /> <span>{title}</span>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Check({
  checked,
  onChange,
  children,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <label className="wfe-check" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

export function MultiPick({
  value,
  options,
  onChange,
  placeholder,
}: {
  value: string[];
  options: Array<[string, string]>;
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const { t } = useI18n();
  return (
    <div className="wfe-multi">
      {value.length > 0 && (
        <div className="wfe-multi-pills">
          {value.map((v) => (
            <span key={v} className="pill">
              {options.find((o) => o[0] === v)?.[1] ?? v}
              <button
                type="button"
                onClick={() => onChange(value.filter((x) => x !== v))}
                aria-label={t("wfe.remove", {
                  name: options.find((o) => o[0] === v)?.[1] ?? v,
                })}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <select value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
        <option value="">{placeholder}</option>
        {options
          .filter((o) => !value.includes(o[0]))
          .map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
      </select>
    </div>
  );
}

export function knowledgeOptions(
  knowledge: KnowledgeOption[],
  skills: boolean,
): Array<[string, string]> {
  return knowledge
    .filter((k) => (k.category === "agent_skill") === skills)
    .map((k) => [
      k.key,
      `${k.title} (${k.key}${skills ? "" : ` · ${k.category}`})${k.enabled ? "" : " [off]"}`,
    ]);
}

export function JsonField({
  value,
  onChange,
  rows = 4,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  rows?: number;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const [bad, setBad] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Reflect edits made through the form fields, but never while the user is typing here.
  useEffect(() => {
    if (document.activeElement !== ref.current) setText(JSON.stringify(value, null, 2));
  }, [value]);
  return (
    <>
      <textarea
        ref={ref}
        className="code"
        rows={rows}
        value={text}
        style={bad ? { borderColor: "var(--err)" } : undefined}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value || "null"));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad && <small className="err">{t("wfe.badJson")}</small>}
    </>
  );
}

export const CONFIGURED = new Set([
  "agent",
  "coding_agent",
  "human_input",
  "human_approval",
  "integration",
  "command",
  "condition",
  "git_pull_request",
]);
