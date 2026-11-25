import { rolesOfSteps } from "../../office/StepChibi.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  useReactFlow,
} from "@xyflow/react";
import {
  ChevronRight,
  GitFork,
  History,
  LayoutGrid,
  MousePointerClick,
  Play,
  Plus,
  Rocket,
  Save,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { api, useApi } from "../../api.ts";
import { dialog } from "../../dialog/index.ts";
import { act, Badge, EmptyState, ErrorBox, Loading, time, toast } from "../../ui.tsx";
import { autoLayout, nodeTypes, placeSteps, toEdges, type StepNodeData } from "../../graph.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { QuickRun } from "./QuickRun.tsx";
import { StepForm } from "./StepForm.tsx";
import { WorkflowForm } from "./WorkflowForm.tsx";
import {
  DEFAULT_CONFIG,
  ErrorsCard,
  type KnowledgeOption,
  PALETTE_GROUPS,
  type Spec,
  type Step,
  TYPE_LABEL,
  type WorkflowDef,
  ancestors,
  typeIcon,
  typeTone,
} from "./shared.tsx";

export function Editor({ wfKey }: { wfKey: string }) {
  const { t } = useI18n();
  const { data: def, error, loading, reload } = useApi<WorkflowDef>(`/api/workflows/${wfKey}`);
  const { data: knowledge } = useApi<KnowledgeOption[]>("/api/knowledge");
  const [spec, setSpec] = useState<Spec | null>(null);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [baseVersion, setBaseVersion] = useState<number | "draft" | null>(null);
  const [note, setNote] = useState("");
  const [showRun, setShowRun] = useState(false);
  const flow = useReactFlow();

  const load = useCallback((s: Spec) => {
    const clean: Spec = {
      ...s,
      steps: s.steps.map((x) => ({
        ...x,
        depends_on: x.depends_on ?? [],
        config: x.config ?? {},
      })),
    };
    setPositions(placeSteps(clean.steps));
    setSpec(clean);
    setDirty(false);
    setErrors([]);
  }, []);
  useEffect(() => {
    if (!def || spec) return;
    const initial = def.draft_spec ?? def.versions[0]?.spec;
    if (initial) load(initial);
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

  const invalidKeys = useMemo(
    () => new Set(errors.flatMap((e) => [...e.matchAll(/"([a-z0-9_-]+)"/g)].map((m) => m[1]))),
    [errors],
  );
  const pickedAt = useRef(0);
  const pickStep = useCallback((key: string) => {
    pickedAt.current = performance.now();
    setSelected(key);
  }, []);
  const nodes: Node<StepNodeData>[] = useMemo(() => {
    const roles = rolesOfSteps(spec?.steps ?? []);
    return (spec?.steps ?? []).map((s) => ({
      id: s.key,
      type: "step",
      position: positions[s.key] ?? { x: 0, y: 0 },
      selected: s.key === selected,
      data: {
        step: s,
        role: roles[s.key],
        selected: s.key === selected,
        invalid: invalidKeys.has(s.key),
        onPick: pickStep,
      },
    }));
  }, [spec, positions, selected, invalidKeys, pickStep]);
  const edges: Edge[] = useMemo(
    () =>
      toEdges(spec?.steps ?? [], undefined, positions).map((e) => ({
        ...e,
        deletable: true,
        selectable: true,
      })),
    [spec, positions],
  );

  // Ctrl+S / ⌘S publishes the workflow (same as the Publish button: validate, save, publish a new version) instead of
  // the browser's "Save page". Declared before the early returns; `publish` is defined below and kept in a ref.
  const publishRef = useRef<() => Promise<void>>(async () => {});
  const publishing = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "s")
        return;
      e.preventDefault();
      if (publishing.current || e.repeat) return;
      publishing.current = true;
      void publishRef.current().finally(() => {
        publishing.current = false;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  if (loading && !def) return <Loading />;
  if (error)
    return (
      <div className="page">
        <ErrorBox error={error} onRetry={reload} />
      </div>
    );
  if (!def)
    return (
      <div className="page">
        <EmptyState title={t("common.notFound")} />
      </div>
    );
  if (!spec) return <Loading />;

  const onNodesChange = (changes: NodeChange<Node<StepNodeData>>[]) => {
    const moved = applyNodeChanges(
      changes.filter((c) => c.type === "position"),
      nodes,
    );
    if (changes.some((c) => c.type === "position")) {
      setPositions(Object.fromEntries(moved.map((n) => [n.id, n.position])));
      if (changes.some((c) => c.type === "position" && !c.dragging)) setDirty(true);
    }
  };
  const onConnect = (c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    if (ancestors(spec.steps, c.source).has(c.target))
      return toast(t("wfe.cycle", { from: c.source, to: c.target }));
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
    const center = flow.screenToFlowPosition({
      x: window.innerWidth / 2 - 300,
      y: window.innerHeight / 2,
    });
    const after = selected ? [selected] : [];
    update((s) => {
      s.steps.push({
        key,
        type,
        name: TYPE_LABEL[type],
        depends_on: after,
        config: structuredClone(DEFAULT_CONFIG[type]),
      });
      return s;
    });
    const base = selected ? positions[selected] : center;
    setPositions((p) => ({
      ...p,
      [key]: selected ? { x: base.x + 270, y: base.y + 40 } : center,
    }));
    setSelected(key);
  };
  const renameStep = (from: string, to: string) => {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(to)) return toast(t("wfe.keyChars"));
    if (spec.steps.some((s) => s.key === to)) return toast(t("wfe.keyExists", { key: to }));
    update((s) => {
      for (const st of s.steps) {
        if (st.key === from) st.key = to;
        st.depends_on = st.depends_on.map((d) => (d === from ? to : d));
        if (st.run_if?.step === from) st.run_if.step = to;
        if (st.config.content_from === from) st.config.content_from = to;
        if (Array.isArray(st.config.show_outputs))
          st.config.show_outputs = st.config.show_outputs.map((d) => (d === from ? to : d));
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
    steps: spec.steps.map((s) => ({
      ...s,
      ui: positions[s.key]
        ? {
            x: Math.round(positions[s.key].x),
            y: Math.round(positions[s.key].y),
          }
        : undefined,
    })),
  });
  const validate = async () => {
    const r = await act(() =>
      api<{ valid: boolean; errors: string[] }>("/api/workflows/validate", { spec: toSave() }),
    );
    if (!r) return false;
    setErrors(r.valid ? [] : r.errors);
    if (r.valid) toast(t("wfe.valid"), "ok");
    return r.valid;
  };
  /** One save/publish at a time: act() only disables the clicked button and is consumed by validate(). */
  const exclusive = async (job: () => Promise<void>) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await job();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const saveDraft = () =>
    exclusive(async () => {
      if (!(await validate())) return;
      if (
        await act(
          () => api(`/api/workflows/${wfKey}/draft`, { spec: toSave() }),
          t("wfe.draftSaved"),
        )
      ) {
        setDirty(false);
        setBaseVersion("draft");
        reload();
      }
    });
  const publish = () =>
    exclusive(async () => {
      if (!(await validate())) return;
      await api(`/api/workflows/${wfKey}/draft`, { spec: toSave() }).catch((e) => toast(e.message));
      const r = await act(() =>
        api<{ unchanged?: boolean; version: number }>(`/api/workflows/${wfKey}/publish`, {
          change_note: note,
        }),
      );
      if (r) {
        toast(r.unchanged ? t("wfe.noChange") : t("wfe.published", { version: r.version }), "ok");
        setDirty(false);
        setNote("");
        setBaseVersion(r.version);
        reload();
      }
    });
  publishRef.current = publish;
  const loadVersion = async (v: string) => {
    if (dirty) {
      const ok = await dialog.confirm({
        title: t("wfe.discard.title"),
        description: t("wfe.discard"),
        confirmLabel: t("wfe.discard.action"),
        cancelLabel: t("common.cancel"),
        variant: "warning",
      });
      if (!ok) return;
    }
    const next =
      v === "draft" ? def.draft_spec : def.versions.find((x) => String(x.version) === v)?.spec;
    if (next) load(next);
    setBaseVersion(v === "draft" ? "draft" : Number(v));
    setSelected(null);
  };

  const step = spec.steps.find((s) => s.key === selected) ?? null;
  const stepKeys = new Set(spec.steps.map((s) => s.key));
  return (
    <div className="wfe">
      <header className="wfe-top">
        <div className="wfe-id">
          <nav className="crumbs wfe-crumbs" aria-label={t("common.breadcrumb")}>
            <a href="#/workflows">{t("nav.workflows")}</a>
            <ChevronRight size={13} aria-hidden />
            <span>{spec.name || wfKey}</span>
          </nav>
          <div className="wfe-title-row">
            <span className="wfe-title-icon">
              <Workflow size={18} strokeWidth={2} />
            </span>
            <h1 className="wfe-title">{spec.name || wfKey}</h1>
            <span className="mono muted wfe-key">{wfKey}</span>
            {def.latest_version ? (
              <Badge s="COMPLETED">
                v{def.latest_version} {t("wfe.publishedBadge")}
              </Badge>
            ) : (
              <Badge s="PENDING">{t("wfe.notPublished")}</Badge>
            )}
            {def.draft_spec && <Badge s="WAITING">{t("wfe.draft")}</Badge>}
            {dirty && <Badge s="WAITING_INPUT">{t("wfe.unsaved")}</Badge>}
          </div>
        </div>
        <div className="wfe-actions">
          <label className="wfe-version" title={t("wfe.loadVersion")}>
            <History size={15} aria-hidden />
            <select
              value={String(baseVersion ?? "")}
              onChange={(e) => void loadVersion(e.target.value)}
              aria-label={t("wfe.openVersion")}
            >
              {def.draft_spec && <option value="draft">{t("wfe.draftOpt")}</option>}
              {def.versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version} · {time(v.published_at)}
                </option>
              ))}
            </select>
          </label>
          <div className="wfe-group">
            <button
              type="button"
              className="sm ghost"
              aria-label={t("wfe.autoLayout")}
              title={t("wfe.autoLayoutTip")}
              onClick={() => {
                const pos = autoLayout(spec.steps);
                setPositions(pos);
                setDirty(true);
                setTimeout(() => flow.fitView({ padding: 0.2 }), 50);
              }}
            >
              <LayoutGrid size={15} /> <span className="wfe-lbl">{t("wfe.autoLayout")}</span>
            </button>
            <button
              type="button"
              className="sm ghost"
              aria-label={t("wfe.validate")}
              disabled={saving}
              onClick={validate}
            >
              <ShieldCheck size={15} /> <span className="wfe-lbl">{t("wfe.validate")}</span>
            </button>
            <button
              type="button"
              className="sm ghost"
              aria-label={t("wfe.saveDraft")}
              disabled={saving}
              onClick={saveDraft}
            >
              <Save size={15} /> <span className="wfe-lbl">{t("wfe.saveDraft")}</span>
            </button>
          </div>
          <div className="wfe-publish">
            <input
              placeholder={t("wfe.changeNote")}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              aria-label={t("wfe.changeNoteAria")}
            />
            <button
              type="button"
              className="sm"
              disabled={saving}
              aria-busy={saving}
              onClick={publish}
              title={t("wfe.publishShortcut")}
              aria-keyshortcuts="Control+S Meta+S"
            >
              <Rocket size={15} /> {t("wfe.publish")}
            </button>
          </div>
          <button
            type="button"
            className={`sm ok${showRun ? " wfe-on" : ""}`}
            disabled={!def.latest_version}
            aria-describedby={def.latest_version ? undefined : "wfe-run-hint"}
            aria-pressed={showRun}
            onClick={() => setShowRun(!showRun)}
          >
            <Play size={15} /> {t("wfe.run")}
          </button>
          {!def.latest_version && (
            <span id="wfe-run-hint" className="muted small">
              {t("wfe.publishFirst")}
            </span>
          )}
        </div>
      </header>

      <div className="wfe-body">
        <aside className="wfe-palette" aria-label={t("wfe.addStep")}>
          <div className="wfe-pal-head">
            <b>{t("wfe.addStep")}</b>
            <span className="muted small">
              {selected ? t("wfe.after", { step: selected }) : t("wfe.clickAdd")}
            </span>
          </div>
          {PALETTE_GROUPS.map(([group, types]) => (
            <div key={group} className="wfe-pal-group">
              <div className="wfe-pal-label">{t(`wfe.group.${group}`)}</div>
              {types.map((type) => {
                const I = typeIcon(type);
                return (
                  <button
                    type="button"
                    key={type}
                    className={`wfe-pal-item ${typeTone(type)}`}
                    onClick={() => addStep(type)}
                    title={`${t(`wfe.type.${type}`)} — ${t(`wfe.desc.${type}`)}`}
                  >
                    <span className="wfe-tile">
                      <I size={16} strokeWidth={2} />
                    </span>
                    <span className="wfe-pal-text">
                      <b>{t(`wfe.type.${type}`)}</b>
                      <small>{t(`wfe.desc.${type}`)}</small>
                    </span>
                    <Plus size={14} className="wfe-pal-plus" aria-hidden />
                  </button>
                );
              })}
            </div>
          ))}
        </aside>

        <div className="canvas wfe-canvas">
          {errors.length > 0 && (
            <ErrorsCard errors={errors} stepKeys={stepKeys} onPick={setSelected} />
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onEdgesDelete={removeEdges}
            onNodesDelete={(ns) => removeSteps(ns.map((n) => n.id))}
            onNodeClick={(_, n) => pickStep(n.id)}
            onPaneClick={() => {
              if (performance.now() - pickedAt.current < 500) return;
              setSelected(null);
            }}
            deleteKeyCode={["Delete", "Backspace"]}
            nodeClickDistance={8}
            nodeDragThreshold={8}
            fitView
            fitViewOptions={{
              padding: 0.25,
              maxZoom: 1,
              minZoom: 0.7,
              nodes: nodes.slice(0, 5).map((n: { id: string }) => ({ id: n.id })),
            }}
            minZoom={0.2}
            ariaLabelConfig={{
              "controls.ariaLabel": t("flow.controls"),
              "controls.zoomIn.ariaLabel": t("flow.zoomIn"),
              "controls.zoomOut.ariaLabel": t("flow.zoomOut"),
              "controls.fitView.ariaLabel": t("flow.fit"),
              "controls.interactive.ariaLabel": t("flow.interactive"),
            }}
          >
            <Background gap={18} />
            <Controls />
          </ReactFlow>
          {spec.steps.length === 0 && (
            <div className="wfe-empty">
              <div className="wfe-empty-card">
                <div className="empty-art">
                  <MousePointerClick size={32} strokeWidth={1.6} color="var(--brand)" />
                </div>
                <b>{t("wfe.emptyCanvas")}</b>
                <p className="muted small">{t("wfe.emptyHint")}</p>
                <div className="row" style={{ justifyContent: "center" }}>
                  <button type="button" className="sm" onClick={() => addStep("agent")}>
                    <Plus size={14} /> {t("wfe.type.agent")}
                  </button>
                  <button
                    type="button"
                    className="sm ghost"
                    onClick={() => addStep("coding_agent")}
                  >
                    <Plus size={14} /> {t("wfe.type.coding_agent")}
                  </button>
                </div>
              </div>
            </div>
          )}
          <div className="wfe-hint" aria-hidden>
            <GitFork size={13} /> {t("wfe.hint")}
          </div>
        </div>

        <aside className="inspector wfe-inspector">
          {showRun ? (
            <QuickRun wfKey={wfKey} onClose={() => setShowRun(false)} />
          ) : step ? (
            <StepForm
              key={step.key}
              step={step}
              spec={spec}
              knowledge={knowledge ?? []}
              updateStep={updateStep}
              renameStep={renameStep}
              removeStep={() => removeSteps([step.key])}
              onBack={() => setSelected(null)}
            />
          ) : (
            <WorkflowForm spec={spec} def={def} knowledge={knowledge ?? []} update={update} />
          )}
        </aside>
      </div>
    </div>
  );
}
