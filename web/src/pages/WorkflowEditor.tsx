import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import {
  ArrowLeft, BookOpen, Braces, ChevronDown, ChevronRight, CircleAlert, Clock, FilePlus2, GitFork, History, Info, LayoutGrid, Layers, MousePointerClick,
  Play, Plus, Repeat, Rocket, Save, Settings2, ShieldCheck, SlidersHorizontal, StepForward, Trash2, Workflow, X, type LucideIcon,
} from "lucide-react";
import { api, useApi } from "../api.ts";
import { act, Badge, ErrorBox, Field, Loading, navigate, time, toast } from "../ui.tsx";
import { autoLayout, nodeTypes, toEdges, type StepNodeData } from "../graph.tsx";
import { ProfilePreview, type ProfileChoice } from "./ProfilePreview.tsx";
import { WF_TYPE_ICON, WF_TYPE_TONE } from "./Workflows.tsx";
import "./WorkflowEditor.css";

type Step = {
  key: string;
  type: string;
  name?: string;
  depends_on: string[];
  config: Record<string, any>;
  run_if?: { step: string; path?: string; equals: unknown };
  requires_approval?: boolean;
  max_attempts?: number;
  retry_backoff_seconds?: number;
  ui?: { x: number; y: number };
};
type Spec = { name: string; description?: string; feedback_step?: string; inputs?: Record<string, any>; knowledge?: string[]; skills?: string[]; steps: Step[] };

const STEP_TYPES = ["agent", "coding_agent", "human_input", "human_approval", "integration", "command", "condition", "git_pull_request", "task_result_report"];
const TYPE_LABEL: Record<string, string> = {
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
const TYPE_DESC: Record<string, string> = {
  agent: "Phân tích, đọc code — không sửa",
  coding_agent: "Sửa code trong worktree, commit",
  human_input: "Hỏi người dùng, chờ trả lời",
  human_approval: "Cổng duyệt trước khi đi tiếp",
  integration: "Discovery repo, gom report…",
  command: "Chạy bash trong từng worktree",
  condition: "Rẽ nhánh theo output bước trước",
  git_pull_request: "Tạo / duyệt pull request",
  task_result_report: "Tổng hợp kết quả task",
};
const PALETTE_GROUPS: Array<[string, string[]]> = [
  ["AI agents", ["agent", "coding_agent"]],
  ["Con người", ["human_input", "human_approval"]],
  ["Logic & tự động", ["condition", "command", "integration"]],
  ["Bàn giao", ["git_pull_request", "task_result_report"]],
];
const typeIcon = (t: string): LucideIcon => WF_TYPE_ICON[t] ?? Layers;
const typeTone = (t: string) => `tone-${WF_TYPE_TONE[t] ?? "logic"}`;
const DEFAULT_CONFIG: Record<string, Record<string, any>> = {
  agent: { instructions: "", output_contract: "{ summary }" },
  coding_agent: { instructions: "Implement the approved plan. Call prepare_branch per repository, edit only in the worktree, commit, then submit_result.", output_contract: "{ summary, pull_requests: { [repo]: { title, summary, decisions } } }" },
  human_input: { questions: [{ question: "", options: [] }] },
  human_approval: { message: "", show_outputs: [] },
  integration: { action: "repository_discovery", use_ai: true, max_candidates: 5 },
  command: { command: "echo ok", timeout_seconds: 600 },
  condition: { path: "upstream.step.output.field", op: "eq", value: true },
  git_pull_request: { mode: "approval", content_from: "" },
  task_result_report: {},
};

function ancestors(steps: Step[], key: string) {
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

export function WorkflowEditor({ wfKey }: { wfKey: string }) {
  return (
    <ReactFlowProvider>
      <Editor wfKey={wfKey} />
    </ReactFlowProvider>
  );
}

function Editor({ wfKey }: { wfKey: string }) {
  const { data: def, error, loading, reload } = useApi<any>(`/api/workflows/${wfKey}`);
  const { data: knowledge } = useApi<any[]>("/api/knowledge");
  const [spec, setSpec] = useState<Spec | null>(null);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [baseVersion, setBaseVersion] = useState<number | "draft" | null>(null);
  const [note, setNote] = useState("");
  const [showRun, setShowRun] = useState(false);
  const flow = useReactFlow();

  const load = useCallback(
    (s: Spec) => {
      const clean: Spec = { ...s, steps: s.steps.map((x) => ({ ...x, depends_on: x.depends_on ?? [], config: x.config ?? {} })) };
      const auto = autoLayout(clean.steps);
      setPositions(Object.fromEntries(clean.steps.map((x) => [x.key, x.ui ?? auto[x.key]])));
      setSpec(clean);
      setDirty(false);
      setErrors([]);
    },
    [],
  );
  useEffect(() => {
    if (!def || spec) return;
    load(def.draft_spec ?? def.versions[0]?.spec);
    setBaseVersion(def.draft_spec ? "draft" : (def.versions[0]?.version ?? null));
  }, [def, spec, load]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => dirty && e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = (fn: (s: Spec) => Spec) => {
    setSpec((s) => (s ? fn(structuredClone(s)) : s));
    setDirty(true);
  };
  const updateStep = (key: string, fn: (st: Step) => void) =>
    update((s) => {
      const st = s.steps.find((x) => x.key === key);
      if (st) fn(st);
      return s;
    });

  const invalidKeys = useMemo(() => new Set(errors.flatMap((e) => [...e.matchAll(/"([a-z0-9_-]+)"/g)].map((m) => m[1]))), [errors]);
  const nodes: Node<StepNodeData>[] = useMemo(
    () =>
      (spec?.steps ?? []).map((s) => ({
        id: s.key,
        type: "step",
        position: positions[s.key] ?? { x: 0, y: 0 },
        selected: s.key === selected,
        data: { step: s, selected: s.key === selected, invalid: invalidKeys.has(s.key) },
      })),
    [spec, positions, selected, invalidKeys],
  );
  const edges: Edge[] = useMemo(() => toEdges(spec?.steps ?? []).map((e) => ({ ...e, deletable: true, selectable: true })), [spec]);

  if (loading && !def) return <Loading />;
  if (error) return <div className="page"><ErrorBox error={error} onRetry={reload} /></div>;
  if (!spec) return <Loading />;

  const onNodesChange = (changes: NodeChange<Node<StepNodeData>>[]) => {
    const moved = applyNodeChanges(changes.filter((c) => c.type === "position"), nodes);
    if (changes.some((c) => c.type === "position")) {
      setPositions(Object.fromEntries(moved.map((n) => [n.id, n.position])));
      if (changes.some((c) => c.type === "position" && !c.dragging)) setDirty(true);
    }
  };
  const onConnect = (c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    if (ancestors(spec.steps, c.source).has(c.target)) return toast(`Nối ${c.source} → ${c.target} sẽ tạo vòng lặp`);
    updateStep(c.target, (st) => {
      if (!st.depends_on.includes(c.source!)) st.depends_on.push(c.source!);
    });
  };
  const removeEdges = (es: Edge[]) =>
    update((s) => {
      for (const e of es) {
        const t = s.steps.find((x) => x.key === e.target);
        if (t) {
          t.depends_on = t.depends_on.filter((d) => d !== e.source);
          if (t.run_if?.step === e.source) delete t.run_if;
        }
      }
      return s;
    });
  const removeSteps = (keys: string[]) => {
    update((s) => {
      s.steps = s.steps.filter((x) => !keys.includes(x.key));
      for (const st of s.steps) {
        st.depends_on = st.depends_on.filter((d) => !keys.includes(d));
        if (st.run_if && keys.includes(st.run_if.step)) delete st.run_if;
      }
      if (s.feedback_step && keys.includes(s.feedback_step)) delete s.feedback_step;
      return s;
    });
    if (selected && keys.includes(selected)) setSelected(null);
  };
  const addStep = (type: string) => {
    let n = 1;
    while (spec.steps.some((s) => s.key === `${type}_${n}`)) n++;
    const key = `${type}_${n}`;
    const center = flow.screenToFlowPosition({ x: window.innerWidth / 2 - 300, y: window.innerHeight / 2 });
    const after = selected ? [selected] : [];
    update((s) => {
      s.steps.push({ key, type, name: TYPE_LABEL[type], depends_on: after, config: structuredClone(DEFAULT_CONFIG[type]) });
      return s;
    });
    const base = selected ? positions[selected] : center;
    setPositions((p) => ({ ...p, [key]: selected ? { x: base.x + 270, y: base.y + 40 } : center }));
    setSelected(key);
  };
  const renameStep = (from: string, to: string) => {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(to)) return toast("Key chỉ gồm a-z 0-9 _ -");
    if (spec.steps.some((s) => s.key === to)) return toast(`Key "${to}" đã tồn tại`);
    update((s) => {
      for (const st of s.steps) {
        if (st.key === from) st.key = to;
        st.depends_on = st.depends_on.map((d) => (d === from ? to : d));
        if (st.run_if?.step === from) st.run_if.step = to;
        if (st.config.content_from === from) st.config.content_from = to;
        if (Array.isArray(st.config.show_outputs)) st.config.show_outputs = st.config.show_outputs.map((d: string) => (d === from ? to : d));
        if (st.config.on_reject?.reexecute === from) st.config.on_reject.reexecute = to;
      }
      if (s.feedback_step === from) s.feedback_step = to;
      return s;
    });
    setPositions((p) => ({ ...p, [to]: p[from] }));
    setSelected(to);
  };
  const toSave = (): Spec => ({
    ...spec,
    steps: spec.steps.map((s) => ({ ...s, ui: positions[s.key] ? { x: Math.round(positions[s.key].x), y: Math.round(positions[s.key].y) } : undefined })),
  });
  const validate = async () => {
    const r = await act(() => api<any>("/api/workflows/validate", { spec: toSave() }));
    if (!r) return false;
    setErrors(r.valid ? [] : r.errors);
    if (r.valid) toast("Workflow hợp lệ ✓", "ok");
    return r.valid as boolean;
  };
  const saveDraft = async () => {
    if (!(await validate())) return;
    if (await act(() => api(`/api/workflows/${wfKey}/draft`, { spec: toSave() }), "Đã lưu draft")) {
      setDirty(false);
      setBaseVersion("draft");
      reload();
    }
  };
  const publish = async () => {
    if (!(await validate())) return;
    await api(`/api/workflows/${wfKey}/draft`, { spec: toSave() }).catch((e) => toast(e.message));
    const r = await act(() => api<any>(`/api/workflows/${wfKey}/publish`, { change_note: note }));
    if (r) {
      toast(r.unchanged ? "Không có thay đổi so với version mới nhất" : `Đã publish v${r.version}`, "ok");
      setDirty(false);
      setNote("");
      setBaseVersion(r.version);
      reload();
    }
  };
  const loadVersion = (v: string) => {
    if (dirty && !confirm("Bỏ các thay đổi chưa lưu?")) return;
    if (v === "draft") load(def.draft_spec);
    else load(def.versions.find((x: any) => String(x.version) === v).spec);
    setBaseVersion(v === "draft" ? "draft" : Number(v));
    setSelected(null);
  };

  const step = spec.steps.find((s) => s.key === selected) ?? null;
  const stepKeys = new Set(spec.steps.map((s) => s.key));
  return (
    <div className="wfe">
      <header className="wfe-top">
        <div className="wfe-id">
          <nav className="crumbs wfe-crumbs" aria-label="Breadcrumb">
            <a href="#/workflows">Workflow Studio</a>
            <ChevronRight size={13} aria-hidden />
            <span>{spec.name || wfKey}</span>
          </nav>
          <div className="wfe-title-row">
            <span className="wfe-title-icon"><Workflow size={18} strokeWidth={2} /></span>
            <h1 className="wfe-title">{spec.name || wfKey}</h1>
            <span className="mono muted wfe-key">{wfKey}</span>
            {def.latest_version ? <Badge s="COMPLETED">v{def.latest_version} published</Badge> : <Badge s="PENDING">chưa publish</Badge>}
            {def.draft_spec && <Badge s="WAITING">draft</Badge>}
            {dirty && <Badge s="WAITING_INPUT">chưa lưu</Badge>}
          </div>
        </div>
        <div className="wfe-actions">
          <label className="wfe-version" title="Load a version into the editor">
            <History size={15} aria-hidden />
            <select value={String(baseVersion ?? "")} onChange={(e) => loadVersion(e.target.value)} aria-label="Version đang mở">
              {def.draft_spec && <option value="draft">draft</option>}
              {def.versions.map((v: any) => <option key={v.version} value={v.version}>v{v.version} · {time(v.published_at)}</option>)}
            </select>
          </label>
          <div className="wfe-group">
            <button className="sm ghost" title="Sắp xếp lại các node" onClick={() => { const pos = autoLayout(spec.steps); setPositions(pos); setDirty(true); setTimeout(() => flow.fitView({ padding: 0.2 }), 50); }}><LayoutGrid size={15} /> <span className="wfe-lbl">Auto layout</span></button>
            <button className="sm ghost" onClick={validate}><ShieldCheck size={15} /> <span className="wfe-lbl">Validate</span></button>
            <button className="sm ghost" onClick={saveDraft}><Save size={15} /> <span className="wfe-lbl">Save draft</span></button>
          </div>
          <div className="wfe-publish">
            <input placeholder="change note" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Change note cho version mới" />
            <button className="sm" onClick={publish}><Rocket size={15} /> Publish</button>
          </div>
          <button className={`sm ok${showRun ? " wfe-on" : ""}`} disabled={!def.latest_version} title={def.latest_version ? "" : "Publish first"} aria-pressed={showRun} onClick={() => setShowRun(!showRun)}><Play size={15} /> Run…</button>
        </div>
      </header>

      <div className="wfe-body">
        <aside className="wfe-palette" aria-label="Thêm bước">
          <div className="wfe-pal-head">
            <b>Thêm bước</b>
            <span className="muted small">{selected ? <>nối sau <span className="mono wfe-pal-after">{selected}</span></> : "bấm để thêm vào canvas"}</span>
          </div>
          {PALETTE_GROUPS.map(([group, types]) => (
            <div key={group} className="wfe-pal-group">
              <div className="wfe-pal-label">{group}</div>
              {types.map((t) => {
                const I = typeIcon(t);
                return (
                  <button key={t} className={`wfe-pal-item ${typeTone(t)}`} onClick={() => addStep(t)} title={`${TYPE_LABEL[t]} — ${TYPE_DESC[t]}`}>
                    <span className="wfe-tile"><I size={16} strokeWidth={2} /></span>
                    <span className="wfe-pal-text">
                      <b>{TYPE_LABEL[t]}</b>
                      <small>{TYPE_DESC[t]}</small>
                    </span>
                    <Plus size={14} className="wfe-pal-plus" aria-hidden />
                  </button>
                );
              })}
            </div>
          ))}
        </aside>

        <div className="canvas wfe-canvas">
          {errors.length > 0 && <ErrorsCard errors={errors} stepKeys={stepKeys} onPick={setSelected} />}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onEdgesDelete={removeEdges}
            onNodesDelete={(ns) => removeSteps(ns.map((n) => n.id))}
            onNodeClick={(_, n) => setSelected(n.id)}
            onPaneClick={() => setSelected(null)}
            deleteKeyCode={["Delete", "Backspace"]}
            fitView
            fitViewOptions={{ padding: 0.25, maxZoom: 1, minZoom: 0.7, nodes: nodes.slice(0, 5).map((n: { id: string }) => ({ id: n.id })) }}
            minZoom={0.2}
          >
            <Background gap={18} />
            <Controls />
          </ReactFlow>
          {spec.steps.length === 0 && (
            <div className="wfe-empty">
              <div className="wfe-empty-card">
                <div className="empty-art"><MousePointerClick size={32} strokeWidth={1.6} color="var(--brand)" /></div>
                <b>Canvas đang trống</b>
                <p className="muted small">Chọn một loại bước ở bảng bên trái, hoặc bắt đầu nhanh:</p>
                <div className="row" style={{ justifyContent: "center" }}>
                  <button className="sm" onClick={() => addStep("agent")}><Plus size={14} /> AI agent</button>
                  <button className="sm ghost" onClick={() => addStep("coding_agent")}><Plus size={14} /> Coding agent</button>
                </div>
              </div>
            </div>
          )}
          <div className="wfe-hint" aria-hidden>
            <GitFork size={13} /> Kéo từ chấm dưới của một node sang chấm trên của node khác để nối · chọn cạnh/node rồi <span className="kbd">Delete</span> để xoá
          </div>
        </div>

        <aside className="inspector wfe-inspector">
          {showRun ? (
            <QuickRun wfKey={wfKey} onClose={() => setShowRun(false)} />
          ) : step ? (
            <StepForm key={step.key} step={step} spec={spec} knowledge={knowledge ?? []} updateStep={updateStep} renameStep={renameStep} removeStep={() => removeSteps([step.key])} onBack={() => setSelected(null)} />
          ) : (
            <WorkflowForm spec={spec} def={def} knowledge={knowledge ?? []} update={update} />
          )}
        </aside>
      </div>
    </div>
  );
}

function ErrorsCard({ errors, stepKeys, onPick }: { errors: string[]; stepKeys: Set<string>; onPick: (k: string) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="wfe-errors" role="alert">
      <button className="wfe-errors-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <CircleAlert size={16} />
        <b>Workflow chưa hợp lệ</b>
        <span className="count">{errors.length}</span>
        <span className="grow" />
        <ChevronDown size={15} className={open ? "wfe-rot" : ""} />
      </button>
      {open && (
        <ul>
          {errors.map((e) => {
            const keys = [...new Set([...e.matchAll(/"([a-z0-9_-]+)"/g)].map((m) => m[1]).filter((k) => stepKeys.has(k)))];
            return (
              <li key={e}>
                <span>{e}</span>
                {keys.map((k) => <button key={k} className="xs ghost" onClick={() => onPick(k)}>Chọn {k}</button>)}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- forms

function Section({ icon: I, title, children, aside }: { icon: LucideIcon; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="wfe-sec">
      <div className="wfe-sec-head"><I size={14} strokeWidth={2} /> <span>{title}</span>{aside}</div>
      {children}
    </section>
  );
}

function Check({ checked, onChange, children, title }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; title?: string }) {
  return (
    <label className="wfe-check" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

function MultiPick({ value, options, onChange, placeholder }: { value: string[]; options: Array<[string, string]>; onChange: (v: string[]) => void; placeholder: string }) {
  return (
    <div className="wfe-multi">
      {value.length > 0 && (
        <div className="wfe-multi-pills">
          {value.map((v) => (
            <span key={v} className="pill">
              {options.find((o) => o[0] === v)?.[1] ?? v}
              <button type="button" onClick={() => onChange(value.filter((x) => x !== v))} aria-label={`Bỏ ${v}`}><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
      <select value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
        <option value="">{placeholder}</option>
        {options.filter((o) => !value.includes(o[0])).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
      </select>
    </div>
  );
}

function knowledgeOptions(knowledge: any[], skills: boolean): Array<[string, string]> {
  return knowledge.filter((k) => (k.category === "agent_skill") === skills).map((k) => [k.key, `${k.title} (${k.key}${skills ? "" : ` · ${k.category}`})${k.enabled ? "" : " [off]"}`]);
}

function WorkflowForm({ spec, def, knowledge, update }: { spec: Spec; def: any; knowledge: any[]; update: (fn: (s: Spec) => Spec) => void }) {
  const scoped = knowledge.filter((k) => k.scope_type === "WORKFLOW" && k.scope_ref === def.key);
  return (
    <div className="wfe-form">
      <div className="wfe-insp-head">
        <span className="wfe-tile tone-ai"><Settings2 size={17} strokeWidth={2} /></span>
        <div className="wfe-insp-title">
          <b>Cấu hình workflow</b>
          <span className="muted small">{spec.steps.length} bước · chọn một node để cấu hình bước</span>
        </div>
      </div>
      <div className="wfe-insp-body">
        <Section icon={Info} title="Thông tin chung">
          <Field label="Name"><input value={spec.name} onChange={(e) => update((s) => ({ ...s, name: e.target.value }))} /></Field>
          <Field label="Description"><textarea rows={2} value={spec.description ?? ""} onChange={(e) => update((s) => ({ ...s, description: e.target.value }))} /></Field>
          <Field label="Feedback step" hint="Bước nhận feedback review (“Gửi feedback” trên run).">
            <select value={spec.feedback_step ?? ""} onChange={(e) => update((s) => ({ ...s, feedback_step: e.target.value || undefined }))}>
              <option value="">(coding step đầu tiên)</option>
              {spec.steps.map((s) => <option key={s.key} value={s.key}>{s.key}</option>)}
            </select>
          </Field>
        </Section>
        <Section icon={BookOpen} title="Skills & knowledge">
          <Field label="Skills cho mọi bước"><MultiPick value={spec.skills ?? []} options={knowledgeOptions(knowledge, true)} placeholder="+ thêm skill" onChange={(v) => update((s) => ({ ...s, skills: v }))} /></Field>
          <Field label="Business rules / guidelines cho mọi bước"><MultiPick value={spec.knowledge ?? []} options={knowledgeOptions(knowledge, false)} placeholder="+ thêm knowledge" onChange={(v) => update((s) => ({ ...s, knowledge: v }))} /></Field>
          {scoped.length > 0 && (
            <div className="wfe-note small">
              <div className="muted">Knowledge có scope WORKFLOW:{def.key} (tự áp dụng):</div>
              {scoped.map((k) => <div key={k.key}><BookOpen size={12} /> <a href={`#/knowledge/${k.key}`}>{k.title}</a></div>)}
            </div>
          )}
        </Section>
        <Section icon={Braces} title="Run inputs">
          <Field label="Run inputs (JSON, mô tả các input form chạy cần)">
            <JsonField value={spec.inputs ?? {}} onChange={(v) => update((s) => ({ ...s, inputs: v }))} />
          </Field>
        </Section>
        <Section icon={History} title="Versions" aside={<span className="count wfe-sec-count">{def.versions.length}</span>}>
          {def.versions.length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>Chưa publish version nào.</p>
          ) : (
            <ol className="wfe-versions">
              {def.versions.map((v: any) => (
                <li key={v.version}>
                  <span className="wfe-v">v{v.version}</span>
                  <div>
                    <div className="small">{v.change_note || <span className="muted">Không có ghi chú</span>}</div>
                    <div className="muted wfe-v-time"><Clock size={11} /> {time(v.published_at)}</div>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <p className="muted small" style={{ marginBottom: 0 }}>Run đang chạy luôn giữ version lúc bắt đầu.</p>
        </Section>
      </div>
    </div>
  );
}

function JsonField({ value, onChange, rows = 4 }: { value: unknown; onChange: (v: any) => void; rows?: number }) {
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
      {bad && <small className="err">JSON không hợp lệ — chưa áp dụng</small>}
    </>
  );
}

const CONFIG_TITLE: Record<string, string> = {
  agent: "Agent", coding_agent: "Coding agent", human_input: "Câu hỏi", human_approval: "Approval", integration: "Integration",
  command: "Command", condition: "Condition", git_pull_request: "Pull request",
};

function StepForm({ step, spec, knowledge, updateStep, renameStep, removeStep, onBack }: {
  step: Step; spec: Spec; knowledge: any[]; updateStep: (k: string, fn: (s: Step) => void) => void; renameStep: (a: string, b: string) => void; removeStep: () => void; onBack: () => void;
}) {
  const [keyDraft, setKeyDraft] = useState(step.key);
  const set = (fn: (s: Step) => void) => updateStep(step.key, fn);
  const cfg = step.config;
  const setCfg = (k: string, v: unknown) => set((s) => (v === undefined || v === "" ? delete s.config[k] : (s.config[k] = v)));
  const anc = [...ancestors(spec.steps, step.key)];
  const others = spec.steps.filter((s) => s.key !== step.key).map((s) => s.key);
  const isAgent = step.type === "agent" || step.type === "coding_agent";
  const I = typeIcon(step.type);
  return (
    <div className="wfe-form">
      <div className="wfe-insp-head">
        <button className="quiet icon" onClick={onBack} aria-label="Về cấu hình workflow" title="Về cấu hình workflow"><ArrowLeft size={17} /></button>
        <span className={`wfe-tile ${typeTone(step.type)}`}><I size={17} strokeWidth={2} /></span>
        <div className="wfe-insp-title">
          <b>{step.name || step.key}</b>
          <span className="muted small">{TYPE_LABEL[step.type] ?? step.type} · <span className="mono">{step.key}</span></span>
        </div>
        <button className="xs danger" onClick={removeStep}><Trash2 size={13} /> Xoá bước</button>
      </div>
      <div className="wfe-insp-body">
        <Section icon={Info} title="Thông tin chung">
          <div className="grid2">
            <Field label="Key"><input value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} onBlur={() => keyDraft !== step.key && renameStep(step.key, keyDraft)} /></Field>
            <Field label="Name"><input value={step.name ?? ""} onChange={(e) => set((s) => (s.name = e.target.value))} /></Field>
          </div>
          <Field label="Type">
            <select value={step.type} onChange={(e) => set((s) => { s.type = e.target.value; s.config = structuredClone(DEFAULT_CONFIG[e.target.value]); })}>
              {STEP_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
          </Field>
          <Field label="Depends on"><MultiPick value={step.depends_on} options={others.filter((k) => !spec.steps.find((s) => s.key === k && ancestors(spec.steps, k).has(step.key))).map((k) => [k, k])} placeholder="+ phụ thuộc vào…" onChange={(v) => set((s) => (s.depends_on = v))} /></Field>
        </Section>

        {CONFIG_TITLE[step.type] && (
          <Section icon={I} title={CONFIG_TITLE[step.type]}>
            {isAgent && (
              <>
                <Field label="Instructions (prompt của bước)" hint="Đi vào system prompt (trusted). Dữ liệu task/output bước trước được truyền riêng dạng untrusted.">
                  <textarea rows={8} value={cfg.instructions ?? ""} onChange={(e) => setCfg("instructions", e.target.value)} />
                </Field>
                <Field label="Output contract"><textarea className="code" rows={2} value={cfg.output_contract ?? ""} onChange={(e) => setCfg("output_contract", e.target.value)} /></Field>
                <Field label="Skills"><MultiPick value={cfg.skills ?? []} options={knowledgeOptions(knowledge, true)} placeholder="+ gán skill" onChange={(v) => setCfg("skills", v.length ? v : undefined)} /></Field>
                <Field label="Business rules / guidelines"><MultiPick value={cfg.knowledge ?? []} options={knowledgeOptions(knowledge, false)} placeholder="+ gán knowledge" onChange={(v) => setCfg("knowledge", v.length ? v : undefined)} /></Field>
                <Check title="Optional: the agent may hand independent read-only exploration/review to explorer/reviewer subagents running in parallel. Off by default." checked={!!cfg.delegation?.enabled} onChange={(c) => setCfg("delegation", c ? { enabled: true, agents: ["explorer", "reviewer"] } : undefined)}>
                  Cho phép delegate cho subagent read-only (explorer / reviewer) để chạy song song
                </Check>
                <div className="grid2">
                  <Field label="Model (trống = mặc định)"><input value={cfg.model ?? ""} onChange={(e) => setCfg("model", e.target.value)} /></Field>
                  <Field label="Max turns"><input type="number" value={cfg.max_turns ?? ""} onChange={(e) => setCfg("max_turns", e.target.value ? Number(e.target.value) : undefined)} /></Field>
                </div>
              </>
            )}
            {step.type === "human_input" && (
              <div className="wfe-questions">
                {(cfg.questions ?? []).map((q: any, i: number) => (
                  <div key={i} className="wfe-question">
                    <div className="wfe-question-head">
                      <span className="wfe-qn">{i + 1}</span>
                      <span className="grow muted small">Câu hỏi</span>
                      <button className="quiet xs" onClick={() => set((s) => s.config.questions.splice(i, 1))}><Trash2 size={12} /> Xoá câu hỏi</button>
                    </div>
                    <input placeholder="Câu hỏi" value={q.question} onChange={(e) => set((s) => (s.config.questions[i].question = e.target.value))} />
                    <input placeholder="Lựa chọn (phân cách bằng dấu phẩy)" value={(q.options ?? []).join(", ")} onChange={(e) => set((s) => (s.config.questions[i].options = e.target.value.split(",").map((x) => x.trim()).filter(Boolean)))} />
                  </div>
                ))}
                <button className="xs ghost" onClick={() => set((s) => (s.config.questions = [...(s.config.questions ?? []), { question: "", options: [] }]))}><Plus size={12} /> câu hỏi</button>
              </div>
            )}
            {step.type === "human_approval" && (
              <>
                <Field label="Message"><input value={cfg.message ?? ""} onChange={(e) => setCfg("message", e.target.value)} /></Field>
                <Field label="Hiển thị output của"><MultiPick value={cfg.show_outputs ?? []} options={anc.map((k) => [k, k])} placeholder="+ bước phía trước" onChange={(v) => setCfg("show_outputs", v)} /></Field>
                <Check checked={!!cfg.select_repositories} onChange={(c) => setCfg("select_repositories", c || undefined)}>Cho phép chọn repository khi duyệt</Check>
                {cfg.select_repositories && <Check checked={!!cfg.auto_approve_unambiguous} onChange={(c) => setCfg("auto_approve_unambiguous", c || undefined)}>Tự duyệt khi gợi ý repo rõ ràng</Check>}
                <Field label="Khi reject, làm lại bước">
                  <select value={cfg.on_reject?.reexecute ?? ""} onChange={(e) => setCfg("on_reject", e.target.value ? { reexecute: e.target.value } : undefined)}>
                    <option value="">(đánh dấu FAILED)</option>
                    {anc.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </Field>
              </>
            )}
            {step.type === "integration" && (
              <>
                <Field label="Action">
                  <select value={cfg.action ?? ""} onChange={(e) => set((s) => (s.config = { action: e.target.value }))}>
                    <option value="repository_discovery">repository_discovery — gợi ý repo (có giải thích)</option>
                    <option value="select_repositories">select_repositories — dùng repo chọn lúc chạy</option>
                    <option value="publish_report">publish_report — gom findings thành report</option>
                    <option value="noop">noop</option>
                  </select>
                </Field>
                {cfg.action === "repository_discovery" && (
                  <div className="grid2 wfe-align-end">
                    <Check checked={!!cfg.use_ai} onChange={(c) => setCfg("use_ai", c)}>AI re-ranking</Check>
                    <Field label="Max candidates"><input type="number" value={cfg.max_candidates ?? 5} onChange={(e) => setCfg("max_candidates", Number(e.target.value))} /></Field>
                  </div>
                )}
                {cfg.action === "publish_report" && (
                  <>
                    <Field label="Title"><input value={cfg.title ?? ""} onChange={(e) => setCfg("title", e.target.value)} /></Field>
                    <Field label="Gom từ các bước"><MultiPick value={cfg.from ?? []} options={anc.map((k) => [k, k])} placeholder="+ bước" onChange={(v) => setCfg("from", v)} /></Field>
                  </>
                )}
              </>
            )}
            {step.type === "command" && (
              <>
                <Field label="Command (bash, chạy trong từng worktree)" hint="Biến môi trường: BASE_BRANCH, REPO, BRANCH, RUN_ID"><textarea className="code" rows={6} value={cfg.command ?? ""} onChange={(e) => setCfg("command", e.target.value)} /></Field>
                <div className="grid2 wfe-align-end">
                  <Field label="Timeout (s)"><input type="number" value={cfg.timeout_seconds ?? 600} onChange={(e) => setCfg("timeout_seconds", Number(e.target.value))} /></Field>
                  <Check checked={!!cfg.allow_failure} onChange={(c) => setCfg("allow_failure", c || undefined)}>Cho phép lỗi</Check>
                </div>
              </>
            )}
            {step.type === "condition" && (
              <div className="grid3">
                <Field label="Path"><input value={cfg.path ?? ""} onChange={(e) => setCfg("path", e.target.value)} /></Field>
                <Field label="Op">
                  <select value={cfg.op ?? "truthy"} onChange={(e) => setCfg("op", e.target.value)}>
                    {["eq", "ne", "gt", "lt", "exists", "truthy", "contains"].map((o) => <option key={o}>{o}</option>)}
                  </select>
                </Field>
                <Field label="Value (JSON)"><input value={JSON.stringify(cfg.value ?? null)} onChange={(e) => { try { setCfg("value", JSON.parse(e.target.value)); } catch {} }} /></Field>
              </div>
            )}
            {step.type === "git_pull_request" && (
              <>
                <Field label="Mode">
                  <select value={cfg.mode ?? "auto"} onChange={(e) => setCfg("mode", e.target.value)}>
                    <option value="approval">approval — duyệt (xem diff) trước khi tạo PR</option>
                    <option value="auto">auto — tạo PR ngay</option>
                    <option value="draft">draft — tạo draft PR</option>
                    <option value="none">none — không tạo PR</option>
                  </select>
                </Field>
                <Field label="Lấy title/description từ bước">
                  <select value={cfg.content_from ?? ""} onChange={(e) => setCfg("content_from", e.target.value)}>
                    <option value="">(tự tìm bước có pull_requests)</option>
                    {anc.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </Field>
              </>
            )}
          </Section>
        )}

        <Section icon={Repeat} title="Execution · approval & retries">
          <Check checked={!!step.requires_approval} onChange={(c) => set((s) => (s.requires_approval = c || undefined))}>Cần duyệt trước khi chạy (approval gate)</Check>
          <div className="grid2">
            <Field label="Max attempts"><input type="number" min={1} max={10} value={step.max_attempts ?? 1} onChange={(e) => set((s) => (s.max_attempts = Number(e.target.value)))} /></Field>
            <Field label="Retry backoff (s)"><input type="number" min={0} value={step.retry_backoff_seconds ?? 5} onChange={(e) => set((s) => (s.retry_backoff_seconds = Number(e.target.value)))} /></Field>
          </div>
          <Field label="Chỉ chạy nếu (run_if)" hint="So sánh output.result (hoặc path) của một bước phía trước.">
            <div className="grid3">
              <select value={step.run_if?.step ?? ""} onChange={(e) => set((s) => (e.target.value ? (s.run_if = { step: e.target.value, equals: s.run_if?.equals ?? true, path: s.run_if?.path }) : delete s.run_if))}>
                <option value="">(luôn chạy)</option>
                {anc.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              {step.run_if && <input placeholder="path (result)" value={step.run_if.path ?? ""} onChange={(e) => set((s) => (s.run_if!.path = e.target.value || undefined))} />}
              {step.run_if && <input placeholder="equals (JSON)" defaultValue={JSON.stringify(step.run_if.equals)} onBlur={(e) => { try { const v = JSON.parse(e.target.value); set((s) => (s.run_if!.equals = v)); } catch { toast("equals phải là JSON"); } }} />}
            </div>
          </Field>
        </Section>

        <details className="wfe-sec wfe-adv">
          <summary className="wfe-sec-head"><SlidersHorizontal size={14} strokeWidth={2} /> <span>Advanced: config JSON</span><ChevronDown size={14} className="wfe-adv-chev" /></summary>
          <JsonField value={cfg} rows={10} onChange={(v) => v && typeof v === "object" && set((s) => (s.config = v))} />
        </details>
      </div>
    </div>
  );
}

function QuickRun({ wfKey, onClose }: { wfKey: string; onClose: () => void }) {
  const { data: repos } = useApi<any[]>("/api/repositories");
  const { data: items } = useApi<any[]>("/api/work-items");
  const [sel, setSel] = useState<string[]>([]);
  const [wi, setWi] = useState("");
  const [inputs, setInputs] = useState("{}");
  const [profile, setProfile] = useState<ProfileChoice>("AUTO");
  const start = async (mode: "start" | "step" | "pending") => {
    let parsed;
    try {
      parsed = JSON.parse(inputs || "{}");
    } catch {
      return toast("Inputs không phải JSON hợp lệ");
    }
    const r = await act(() => api<any>("/api/runs", { workflow: wfKey, work_item_id: wi ? Number(wi) : null, repositories: sel, inputs: { ...parsed, ...(sel.length ? { repositories: sel } : {}) }, start: mode === "start", profile }));
    if (!r) return;
    if (mode === "step") await act(() => api(`/api/runs/${r.id}/start`, { step_mode: true }));
    navigate(`/runs/${r.id}`);
  };
  const enabledRepos = (repos ?? []).filter((r) => r.enabled);
  return (
    <div className="wfe-form">
      <div className="wfe-insp-head">
        <span className="wfe-tile tone-ship"><Play size={17} strokeWidth={2} /></span>
        <div className="wfe-insp-title">
          <b>Chạy {wfKey}</b>
          <span className="muted small">version mới nhất</span>
        </div>
        <button className="quiet icon" onClick={onClose} aria-label="Đóng"><X size={17} /></button>
      </div>
      <div className="wfe-insp-body">
        <Section icon={Layers} title="Ngữ cảnh">
          <Field label="Work item (tuỳ chọn)">
            <select value={wi} onChange={(e) => setWi(e.target.value)}>
              <option value="">(không có — chạy độc lập)</option>
              {(items ?? []).map((w) => <option key={w.id} value={w.id}>{w.code} · {w.title}</option>)}
            </select>
          </Field>
          <div className="field">
            <span>Repositories (để trống = tự discovery)</span>
            {enabledRepos.length === 0 ? (
              <div className="muted small">{repos ? "Không có repository nào đang bật." : "Đang tải…"}</div>
            ) : (
              <div className="wfe-repos">
                {enabledRepos.map((r) => (
                  <label key={r.name} className={`wfe-repo${sel.includes(r.name) ? " on" : ""}`}>
                    <input type="checkbox" checked={sel.includes(r.name)} onChange={(e) => setSel(e.target.checked ? [...sel, r.name] : sel.filter((x) => x !== r.name))} /> {r.name}
                  </label>
                ))}
              </div>
            )}
          </div>
          <Field label="Inputs (JSON)" hint='vd {"project":"OMS","focus":"refund","branch":"TASK-1","risk":"low"}'><textarea className="code" rows={3} value={inputs} onChange={(e) => setInputs(e.target.value)} /></Field>
        </Section>
        <Section icon={Workflow} title="Profile & preview">
          <ProfilePreview workflow={wfKey} workItemId={wi ? Number(wi) : null} repositories={sel} inputs={(() => { try { return JSON.parse(inputs || "{}"); } catch { return {}; } })()} value={profile} onChange={setProfile} />
        </Section>
        <div className="wfe-run-actions">
          <button onClick={() => start("start")}><Play size={15} /> Start</button>
          <button className="ghost" onClick={() => start("step")}><StepForward size={15} /> Step mode</button>
          <button className="ghost" onClick={() => start("pending")}><FilePlus2 size={15} /> Tạo (chưa chạy)</button>
        </div>
      </div>
    </div>
  );
}
