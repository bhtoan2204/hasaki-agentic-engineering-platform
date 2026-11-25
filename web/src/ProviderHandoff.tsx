import { HandoffPreview, type Handoff } from "./HandoffPreview.tsx";
import { useState, useEffect } from "react";
import { useApi } from "./api.ts";
import { ModelSelect, type CatalogModel } from "./ModelSelect.tsx";
import { useI18n } from "./i18n/index.tsx";
import { Field, time } from "./ui.tsx";

interface HandoffStep {
  key: string;
  status: string;
  current_attempt_id?: number | null;
}

interface HandoffAttempt {
  id: number;
  number: number;
  status: string;
  started_at?: string | null;
  executor_stopped_at?: string | null;
  agent_provider?: string | null;
  agent_model?: string | null;
  metrics?: { provider?: string; model?: string } | null;
}

interface ProviderOption {
  provider: string;
  ok: boolean;
  error?: string;
  models?: CatalogModel[];
}

/** Server-owned checkpoints; selecting a provider never starts execution before explicit confirmation. */
export function ProviderHandoff({
  runId,
  step,
  attempts,
  handoffs = [],
  action,
  active = true,
}: {
  active?: boolean;
  runId: number;
  step: HandoffStep;
  attempts: HandoffAttempt[];
  handoffs?: Handoff[];
  action: (path: string, body?: Record<string, unknown>) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [provider, setProvider] = useState("codex"),
    [model, setModel] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [providerTouched, setProviderTouched] = useState(false),
    [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const current = handoffs.find((h) => h.source_attempt_id === step.current_attempt_id);
  useEffect(() => setConfirmed(false), [current?.workspace_fingerprint]);
  const pending = active && current && ["STOPPING", "READY", "BLOCKED"].includes(current.status);
  const {
    data: options,
    error,
    reload,
  } = useApi<ProviderOption[]>(
    show || pending ? `/api/runs/${runId}/steps/${step.key}/handoff-providers` : null,
  );
  const target = options?.find((p) => p.provider === provider);
  // Only agents whose readiness check passed can be chosen; the server refuses the others anyway.
  const healthy: string[] = (options ?? []).filter((p) => p.ok).map((p) => p.provider);
  useEffect(() => {
    if (!options?.length || !current) return;
    if (healthy.includes(provider) && (providerTouched || provider !== current.original_provider))
      return;
    const next = healthy.find((p) => p !== current.original_provider) ?? healthy[0];
    if (next && next !== provider) setProvider(next);
  }, [options, providerTouched, provider, current, healthy]);
  const send = async (path: string, body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await action(path, body);
    } finally {
      setBusy(false);
      setConfirmed(false);
    }
  };

  const resumeHold =
    !current || !pending
      ? null
      : current.status !== "READY"
        ? t("handoff.holdNotReady")
        : !options
          ? t("handoff.holdLoading")
          : !target?.ok
            ? (target?.error ?? t("handoff.holdNotReadyAgent"))
            : !confirmed
              ? t("handoff.reviewCheckpointHint")
              : null;
  const hasBody =
    pending ||
    !!current?.blocked_reason ||
    current?.status === "STOPPING" ||
    handoffs.length > 0 ||
    attempts.length > 1;
  return (
    <section className="card tight" style={{ margin: 12 }}>
      <div className="card-head" style={hasBody ? undefined : { marginBottom: 0 }}>
        <h4>{t("handoff.title")}</h4>
        {!pending &&
          active &&
          ["RUNNING", "FAILED", "WAITING_INPUT", "RETRYING", "CANCELED"].includes(step.status) && (
            <button
              type="button"
              className="sm"
              disabled={busy || !step.current_attempt_id}
              onClick={() => {
                setShow(true);
                void send("handoff", {
                  expected_attempt_id: step.current_attempt_id,
                  reason: t("handoff.userSwitchReason"),
                });
              }}
            >
              {t("handoff.switchBtn")}
            </button>
          )}
      </div>
      {pending && (
        <p role="status">
          <strong>{current.failure_category ?? t("handoff.manualSwitch")}</strong> ·{" "}
          {current.original_provider} · {current.status}
        </p>
      )}
      {current?.status === "BLOCKED" && (
        <div role="alert" className="error">
          <strong>{t("handoff.nextNotStarted")}</strong>
          <p>{t("handoff.blockedDetail")}</p>
          {current.blocked_reason && <p>{current.blocked_reason}</p>}
        </div>
      )}
      {current?.blocked_reason && current.status !== "BLOCKED" && (
        <p className="error">{current.blocked_reason}</p>
      )}
      {current?.status === "STOPPING" && <p className="muted small">{t("handoff.stopping")}</p>}
      {pending && (
        <>
          {(current.status !== "STOPPING" ||
            attempts.find((a) => a.id === current.source_attempt_id)?.executor_stopped_at) && (
            <button
              type="button"
              className="sm ghost"
              disabled={busy}
              onClick={() =>
                send("handoff", {
                  expected_attempt_id: current.source_attempt_id,
                  reason: t("handoff.reinspectReason"),
                })
              }
            >
              {t("handoff.reinspect")}
            </button>
          )}
          <HandoffPreview handoff={current} />
          {error && (
            <p role="alert">
              {String(error)}{" "}
              <button type="button" className="quiet" onClick={reload}>
                {t("handoff.retryCheck")}
              </button>
            </p>
          )}
          <div className="grid2">
            <Field label={t("handoff.targetProvider")}>
              <select
                aria-label={t("handoff.targetProvider")}
                value={provider}
                onChange={(e) => {
                  setProviderTouched(true);
                  setProvider(e.target.value);
                  setModel("");
                  setConfirmed(false);
                }}
              >
                {!options && (
                  <option value={provider} disabled>
                    {t("handoff.checkingAgents")}
                  </option>
                )}
                {options && !healthy.length && (
                  <option value={provider} disabled>
                    {t("handoff.noneReady")}
                  </option>
                )}
                {healthy.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("handoff.targetModel")}>
              <ModelSelect
                ariaLabel={t("handoff.targetModel")}
                value={model}
                models={target?.models ?? []}
                emptyLabel={t("handoff.accountDefault")}
                onChange={(next) => {
                  setModel(next);
                  setConfirmed(false);
                }}
              />
            </Field>
          </div>
          <p className="muted small">
            {target?.ok ? t("handoff.cliReady") : (target?.error ?? t("handoff.checkingProvider"))}
          </p>
          <label className={`handoff-confirm${confirmed ? " is-on" : ""}`}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>{t("handoff.confirmCheckbox")}</span>
          </label>
          {resumeHold && (
            <p id="handoff-resume-hold" className="muted small" role="status">
              {resumeHold}
            </p>
          )}
          <div className="handoff-actions">
            <button
              type="button"
              className="sm"
              disabled={busy || current.status !== "READY" || !target?.ok || !confirmed}
              aria-describedby={resumeHold ? "handoff-resume-hold" : undefined}
              onClick={() =>
                send("handoff-resume", {
                  handoff_id: current.id,
                  expected_attempt_id: current.source_attempt_id,
                  provider,
                  model: model || null,
                  confirm: true,
                  checkpoint_fingerprint: current.workspace_fingerprint,
                })
              }
            >
              {t("handoff.confirmResume")}
            </button>
          </div>
        </>
      )}
      {(handoffs.length > 0 || attempts.length > 1) && (
        <details className="handoff-history">
          <summary>{t("handoff.historyTimeline")}</summary>
          {handoffs.map((h) => (
            <p key={h.id} className="small">
              #{h.id} · {h.original_provider} → {h.target_provider ?? "—"} · {h.status} ·{" "}
              {h.failure_category ?? h.reason} · {time(h.created_at)}
            </p>
          ))}
          {attempts.map((a) => (
            <p key={a.id} className="small">
              #{a.number} · {a.agent_provider ?? a.metrics?.provider ?? "—"} ·{" "}
              {a.agent_model ?? a.metrics?.model ?? "—"} · {a.status} · {time(a.started_at)}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
