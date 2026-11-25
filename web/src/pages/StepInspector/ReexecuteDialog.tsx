import { useEffect, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { useApi } from "../../api.ts";
import { ErrorBox, SkeletonRows } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { DecisionBadge } from "../ExecutionCards";
import type { DecisionAction } from "../../decisions";
import {
  type InspectorRun,
  type ReexecuteBody,
  type ReplayPreviewStep,
  type SkillCatalogEntry,
  type StepRow,
} from "./shared.tsx";

export function ReexecuteDialog({
  run,
  step,
  onSubmit,
  onPreview,
}: {
  run: InspectorRun;
  step: StepRow;
  onSubmit: (body: ReexecuteBody) => Promise<unknown>;
  onPreview?: (plan: Record<string, string> | null) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [persist, setPersist] = useState(true);
  const [busy, setBusy] = useState(false);
  const { data: catalog } = useApi<SkillCatalogEntry[]>(
    open ? "/api/knowledge?category=agent_skill" : null,
    [open],
  );
  const [force, setForce] = useState(false);
  const {
    data: preview,
    error: previewError,
    reload: reloadPreview,
  } = useApi<{
    can_reexecute: boolean;
    continuation: { action: DecisionAction; reason: string } | null;
    steps: ReplayPreviewStep[];
    summary?: {
      actions: Record<string, number>;
      estimated_avoided: { invocations: number | null; tokens: number | null };
    };
  }>(
    open ? `/api/runs/${run.id}/steps/${step.key}/replay-preview${force ? "?force=1" : ""}` : null,
    [open, force],
  );
  // The run's DAG shows the planned decision of every node while this preview is open.
  useEffect(() => {
    if (!onPreview) return;
    onPreview(
      open && preview ? Object.fromEntries(preview.steps.map((s) => [s.key, s.action])) : null,
    );
  }, [open, preview, onPreview]);
  useEffect(() => () => onPreview?.(null), [onPreview]);
  if (!open)
    return (
      <div
        className="rv-card soft"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <button type="button" className="sm" onClick={() => setOpen(true)}>
          <RotateCcw size={13} /> {t("si.reexecuteWord")}…
        </button>
        <span className="muted small grow">{t("si.rerunHint")}</span>
      </div>
    );
  return (
    <section
      className="rv-card"
      style={{
        borderColor: "var(--brand-400)",
        boxShadow: "0 0 0 3px var(--focus), var(--shadow-2)",
      }}
      aria-label={t("si.reexecuteWord")}
    >
      <div className="rv-card-head">
        <h4>
          <RotateCcw size={16} /> {t("si.rerunTitle", { name: step.name })}
        </h4>
        <button
          type="button"
          className="quiet icon"
          aria-label={t("common.close")}
          onClick={() => setOpen(false)}
        >
          <X size={16} />
        </button>
      </div>
      <label className="field" style={{ marginTop: 0 }}>
        <span>{t("si.guidance")}</span>
        <textarea
          rows={4}
          autoFocus
          placeholder={t("si.guidancePh")}
          aria-label={t("si.guidancePh")}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {text.trim() && (
        <label
          className="small"
          style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 6 }}
        >
          <input
            type="checkbox"
            checked={persist}
            onChange={(e) => setPersist(e.target.checked)}
            style={{ marginTop: 2, flex: "none" }}
          />
          <span>
            <b>{t("si.persistDecision")}</b>
            <span className="muted"> — {t("si.persistDecisionHint")}</span>
          </span>
        </label>
      )}
      <div className="field">
        <span>
          {t("si.skillsThis")}{" "}
          <span className="muted" style={{ fontWeight: 400 }}>
            ({t("si.pinVersion")})
          </span>
        </span>
        {skills.length > 0 && (
          <div style={{ marginBottom: 6 }}>
            {skills.map((k) => (
              <span key={k} className="pill chip-brand">
                {catalog?.find((c) => c.key === k)?.title ?? k}
                <button
                  type="button"
                  aria-label={t("wfe.remove", { name: k })}
                  onClick={() => setSkills(skills.filter((x) => x !== k))}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <select value="" onChange={(e) => e.target.value && setSkills([...skills, e.target.value])}>
          <option value="">{t("si.addSkill")}</option>
          {(catalog ?? [])
            .filter((c) => !skills.includes(c.key))
            .map((c) => (
              <option key={c.key} value={c.key}>
                {c.title} ({c.key} v{c.current_version}){c.enabled ? "" : " [off]"}
              </option>
            ))}
        </select>
      </div>
      <label className="small" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
        {t("si.forceReplay")}
      </label>
      <div className="rv-card soft" style={{ margin: "10px 0 0", padding: "10px 12px" }}>
        <strong className="small">{t("si.replayPreview")}</strong>
        {previewError ? (
          <ErrorBox error={previewError} onRetry={reloadPreview} />
        ) : !preview ? (
          <SkeletonRows rows={2} />
        ) : (
          <>
            {preview.continuation && (
              <p className="small">
                <DecisionBadge action={preview.continuation.action} /> ·{" "}
                {preview.continuation.reason}
              </p>
            )}
            {preview.summary && (
              <p className="small muted ec-preview-summary">
                {t("rx.summary", {
                  summary: Object.entries(preview.summary.actions)
                    .map(([a, n]) => `${n} ${t(`dec.action.${a}`)}`)
                    .join(", "),
                })}
                {preview.summary.estimated_avoided.tokens != null &&
                  ` · ${t("rx.avoided", {
                    calls: Math.round(preview.summary.estimated_avoided.invocations ?? 0),
                    tokens: Math.round(preview.summary.estimated_avoided.tokens).toLocaleString(),
                  })}`}
              </p>
            )}
            <ul className="small ec-preview">
              {[...preview.steps]
                .sort((a, b) => a.action.localeCompare(b.action))
                .map((item) => (
                  <li key={item.key} className="ec-preview-step">
                    <code>{item.key}</code> · <DecisionBadge action={item.action} />
                    {item.conditional && ` (${t("si.replayConditional")})`} · {item.reason}
                    {item.estimate?.tokens != null &&
                      ` · ${t("rx.estimate", { tokens: Math.round(item.estimate.tokens).toLocaleString() })}`}
                  </li>
                ))}
            </ul>
          </>
        )}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button
          type="button"
          disabled={busy || preview?.can_reexecute === false}
          aria-describedby={preview?.can_reexecute === false ? "si-reexec-hint" : undefined}
          onClick={async () => {
            setBusy(true);
            const r = await onSubmit({
              ...(text.trim() ? { feedback: text.trim(), persist } : {}),
              ...(skills.length ? { skills } : {}),
              ...(force ? { force } : {}),
            });
            setBusy(false);
            if (r !== undefined) {
              setOpen(false);
              setText("");
              setSkills([]);
            }
          }}
        >
          <RotateCcw size={14} />
          {busy ? t("pe.creating") : t("si.confirmRerun")}
        </button>
        {preview?.can_reexecute === false && (
          <span id="si-reexec-hint" className="muted small">
            {t("hint.cannotReexecute")}
          </span>
        )}
        <button type="button" className="ghost" onClick={() => setOpen(false)}>
          {t("common.cancel")}
        </button>
      </div>
    </section>
  );
}
