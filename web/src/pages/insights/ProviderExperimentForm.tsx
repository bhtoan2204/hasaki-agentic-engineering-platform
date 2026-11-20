import { useState } from "react";
import { api, useApi } from "../../api.ts";
import { act, ErrorBox, Field, SkeletonRows, navigate } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { Panel, Notice } from "../analytics/shared.tsx";
const plans = [
  "claude",
  "codex",
  "cursor",
  "antigravity",
  "copilot",
  "claude,codex",
  "codex,claude",
  "claude,antigravity",
  "claude,copilot",
  "claude,codex,cursor",
];
export function ProviderExperimentForm({
  admin,
  onCreated,
}: {
  admin: boolean;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const suites = useApi<Array<{ id: number }>>("/api/benchmark-suites");
  const [plan, setPlan] = useState("claude,codex"),
    [models, setModels] = useState<string[]>([]),
    [variant, setVariant] = useState("tools"),
    [reps, setReps] = useState(2),
    [limit, setLimit] = useState(3),
    [busy, setBusy] = useState(false),
    [mode, setMode] = useState("fixture"),
    [paid, setPaid] = useState(false);
  const queue = async (ab = false) => {
    const suite = suites.data?.[0];
    if (!suite) return;
    setBusy(true);
    try {
      await act(
        async () => {
          for (const context_variant of ab ? ["minimal", "pack", "tools"] : [variant]) {
            const provider_sequence = plan
              .split(",")
              .map((provider, i) => ({ provider, model: models[i] || null }));
            const row = await api<{ id: number }>("/api/evaluation-runs", {
              suite_id: suite.id,
              request_key: crypto.randomUUID(),
              paid_approval: paid,
              configuration: {
                mode,
                adapter: "provider_fixture",
                provider: mode === "live" ? provider_sequence[0].provider : "fixture",
                provider_sequence,
                context_variant,
                repetitions: reps,
                case_limit: limit,
              },
            });
            await api(`/api/evaluation-runs/${row.id}/start`, {});
          }
          onCreated();
        },
        t("an.eval.queued"),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title={t("an.eval.experiments")}>
      <Notice>
        {t("an.eval.fixtureControlsNotice")}
      </Notice>
      {suites.loading && !suites.data && <SkeletonRows rows={2} />}
      {suites.error && <ErrorBox error={suites.error} onRetry={suites.reload} />}
      {!suites.loading && !suites.data?.length && (
        <p>
          {t("an.eval.publishSuiteFirst")}
          {admin && (
            <button
              className="sm"
              onClick={() =>
                act(async () => {
                  await api("/api/benchmark-suites/publish", {});
                  await suites.reload();
                })
              }
            >
              {t("an.eval.publishSuite")}
            </button>
          )}
        </p>
      )}
      <div className="an-filter-grid">
        <Field label={t("an.eval.providerSequence")}>
          <select
            aria-label={t("an.eval.providerSequence")}
            value={plan}
            onChange={(e) => {
              setPlan(e.target.value);
              setModels([]);
            }}
          >
            {plans.map((p) => (
              <option key={p} value={p}>
                {p.split(",").join(" → ")}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("an.eval.contextVariant")}>
          <select
            aria-label={t("an.eval.contextVariant")}
            value={variant}
            onChange={(e) => setVariant(e.target.value)}
          >
            <option value="minimal">A · {t("an.eval.minimalTask")}</option>
            <option value="pack">B · {t("an.eval.contextPack")}</option>
            <option value="tools">C · {t("an.eval.packTools")}</option>
          </select>
        </Field>
        <Field label={t("an.eval.repetitions")}>
          <input
            aria-label={t("an.eval.repetitions")}
            type="number"
            min={1}
            max={3}
            value={reps}
            onChange={(e) => setReps(Number(e.target.value))}
          />
        </Field>
        <Field label={t("an.eval.casesCount")}>
          <input
            aria-label={t("an.eval.casesCount")}
            type="number"
            min={1}
            max={20}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          />
        </Field>
        {plan.split(",").map((provider, i) => (
          <Field key={i} label={`${provider} · ${t("an.eval.configuredModelLabel")}`}>
            <input
              value={models[i] ?? ""}
              placeholder={t("an.eval.defaultUnreported")}
              onChange={(e) =>
                setModels((old) => {
                  const next = [...old];
                  next[i] = e.target.value;
                  return next;
                })
              }
            />
          </Field>
        ))}
        <Field label={t("an.eval.execution")}>
          <select
            value={mode}
            onChange={(e) => {
              setMode(e.target.value);
              setPaid(false);
            }}
          >
            <option value="fixture">{t("an.eval.fixtureControls")}</option>
            <option value="dry_run">{t("an.eval.dryRun")}</option>
            {admin && (
              <option value="live">
                {t("an.eval.liveCapabilityCheck")}
              </option>
            )}
          </select>
        </Field>
      </div>
      {mode === "live" && (
        <label>
          <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} />
          {t("an.eval.recordAdminApproval")}
        </label>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="sm"
          disabled={busy || !suites.data?.length || (mode === "live" && !paid)}
          onClick={() => queue()}
        >
          {t("an.eval.queueEval")}
        </button>
        <button
          className="sm ghost"
          disabled={busy || !suites.data?.length || mode !== "fixture"}
          onClick={() => queue(true)}
        >
          {t("an.eval.queueStudy")}
        </button>
        <button className="quiet sm" onClick={() => navigate("/insights/quality")}>
          {t("an.eval.existingRunnerBtn")}
        </button>
      </div>
    </Panel>
  );
}
