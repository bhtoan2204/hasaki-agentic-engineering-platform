import { useCallback, useEffect, useState } from "react";
import { Bot, RotateCcw } from "lucide-react";
import { api, useApi } from "../api.ts";
import { useI18n } from "../i18n/index.tsx";
import { changedDefaultFields, providerDraftPatch } from "../agentConfiguration.ts";
import {
  AgentValueFields,
  ModelCombobox,
  resolveSupportedEfforts,
  type AgentValues,
  type AgentControls,
  type AgentCatalogModel,
} from "../AgentValueFields.tsx";
import { Button, EmptyState, ErrorBox, Field, SkeletonRows } from "../ui.tsx";

interface ProviderConfiguration {
  revision: number;
  enabled: boolean;
  defaults: AgentValues;
  profiles: Record<string, Record<string, AgentValues>>;
}
interface View {
  document: {
    default_provider: string;
    default_revision?: number;
    providers: Record<string, ProviderConfiguration>;
  };
  controls: Record<string, AgentControls>;
  scopes: string[];
  roles: string[];
}
interface Catalog {
  id: string;
  controls?: AgentControls;
  models?: AgentCatalogModel[];
  discovery?: string;
  cache?: string;
  discovered_at?: string;
  ok: boolean;
}

function cleanRoleValues(values?: AgentValues): AgentValues {
  if (!values) return {};
  const next: AgentValues = {};
  if (values.model !== undefined) next.model = values.model;
  if (values.reasoning_effort !== undefined) next.reasoning_effort = values.reasoning_effort;
  if (values.max_turns !== undefined) next.max_turns = values.max_turns;
  if (values.timeout_ms !== undefined) next.timeout_ms = values.timeout_ms;
  if (values.options) {
    const opts: NonNullable<AgentValues["options"]> = {};
    if (values.options.sandbox !== undefined) opts.sandbox = values.options.sandbox;
    if (values.options.max_concurrent !== undefined)
      opts.max_concurrent = values.options.max_concurrent;
    if (Object.keys(opts).length > 0) next.options = opts;
  }
  return next;
}

function countRoleOverrides(values?: AgentValues): number {
  if (!values) return 0;
  let count = 0;
  if (values.model !== undefined) count++;
  if (values.reasoning_effort !== undefined) count++;
  if (values.timeout_ms !== undefined) count++;
  if (values.max_turns !== undefined) count++;
  if (values.options?.sandbox !== undefined) count++;
  if (values.options?.max_concurrent !== undefined) count++;
  return count;
}

function countScopeOverrides(
  scopeMap: Record<string, AgentValues> | undefined,
  roles: string[],
): number {
  if (!scopeMap) return 0;
  return roles.reduce((sum, role) => sum + countRoleOverrides(scopeMap[role]), 0);
}

function pruneProfiles(
  profiles: Record<string, Record<string, AgentValues>> | undefined,
): Record<string, Record<string, AgentValues>> {
  if (!profiles) return {};
  const out: Record<string, Record<string, AgentValues>> = {};
  for (const [scope, roles] of Object.entries(profiles)) {
    if (!roles) continue;
    const roleOut: Record<string, AgentValues> = {};
    for (const [role, vals] of Object.entries(roles)) {
      const cleaned = cleanRoleValues(vals);
      if (countRoleOverrides(cleaned) > 0) {
        roleOut[role] = cleaned;
      }
    }
    if (Object.keys(roleOut).length > 0) {
      out[scope] = roleOut;
    }
  }
  return out;
}

function sanitizeDraftForPreview(draft: ProviderConfiguration): ProviderConfiguration {
  const clampTimeout = (ms?: number) =>
    ms !== undefined && Number.isFinite(ms) && ms >= 1000 && ms <= 86_400_000 ? ms : undefined;
  const clampTurns = (turns?: number) =>
    turns !== undefined && Number.isFinite(turns) && turns >= 1 && turns <= 500 ? turns : undefined;
  return {
    ...draft,
    defaults: {
      ...draft.defaults,
      timeout_ms: clampTimeout(draft.defaults.timeout_ms),
      max_turns: clampTurns(draft.defaults.max_turns),
    },
    profiles: Object.fromEntries(
      Object.entries(draft.profiles ?? {}).map(([scope, roles]) => [
        scope,
        Object.fromEntries(
          Object.entries(roles ?? {}).map(([role, vals]) => [
            role,
            {
              ...vals,
              timeout_ms: clampTimeout(vals?.timeout_ms),
              max_turns: clampTurns(vals?.max_turns),
            },
          ]),
        ),
      ]),
    ),
  };
}

export function AgentSettings() {
  const { t } = useI18n();
  const { data, error, loading, reload, setData } = useApi<View>("/api/settings/agents");
  const catalog = useApi<Catalog[]>("/api/agent-providers");
  const [provider, setProvider] = useState("claude");
  const [activeScope, setActiveScope] = useState("*");
  const [drafts, setDrafts] = useState<Record<string, ProviderConfiguration>>({});
  const [editedDefaults, setEditedDefaults] = useState<Record<string, string[]>>({});
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<
    Record<string, { values: AgentValues; sources: Record<string, string> }>
  >({});

  useEffect(() => {
    if (data)
      setDrafts((old) =>
        Object.fromEntries(
          Object.entries(data.document.providers).map(([key, entry]) => [
            key,
            old[key] && old[key].revision === entry.revision ? old[key] : structuredClone(entry),
          ]),
        ),
      );
  }, [data]);

  const draft = drafts[provider];
  const defaultFields = editedDefaults[provider];

  useEffect(() => {
    if (!data || !draft) return;
    let active = true;
    const safeDraft = sanitizeDraftForPreview(draft);
    const timer = setTimeout(() => {
      void Promise.all(
        data.scopes.flatMap((scope) =>
          data.roles.map(async (role) => {
            const result = await api<{ values: AgentValues; sources: Record<string, string> }>(
              "/api/settings/agents/preview",
              {
                provider,
                scope,
                role,
                draft: providerDraftPatch(safeDraft, defaultFields ?? []),
              },
            );
            return [`${scope}/${role}`, result] as const;
          }),
        ),
      )
        .then((entries) => {
          if (active) setPreview(Object.fromEntries(entries));
        })
        .catch((err: Error) => {
          if (active) setNote({ text: err.message, ok: false });
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [data, draft, provider, defaultFields]);

  const isProviderDirty = useCallback(
    (key: string) => {
      const d = drafts[key];
      const saved = data?.document.providers[key];
      if (!d || !saved) return false;
      if (d.enabled !== saved.enabled) return true;
      if ((editedDefaults[key]?.length ?? 0) > 0) return true;
      return (
        JSON.stringify(pruneProfiles(d.profiles)) !== JSON.stringify(pruneProfiles(saved.profiles))
      );
    },
    [data, drafts, editedDefaults],
  );

  const dirty = isProviderDirty(provider);

  const save = useCallback(async () => {
    if (!data || !draft || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const cleanedDraft: ProviderConfiguration = {
        ...draft,
        profiles: pruneProfiles(draft.profiles),
      };
      const next = await api<View>("/api/settings/agents/provider", {
        provider,
        revision: draft.revision,
        patch: providerDraftPatch(cleanedDraft, defaultFields ?? []),
      });
      setData(next);
      setDrafts((old) => ({
        ...old,
        [provider]: structuredClone(next.document.providers[provider]),
      }));
      setEditedDefaults((old) => ({ ...old, [provider]: [] }));
      setNote({ text: "Provider saved", ok: true });
    } catch (err) {
      setNote({ text: (err as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  }, [data, draft, busy, provider, defaultFields, setData]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && dirty) {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, save]);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading && (!data || !draft))
    return (
      <section className="card set-section" id="set-agents">
        <SkeletonRows rows={5} />
      </section>
    );
  if (!data || !draft)
    return (
      <section className="card set-section" id="set-agents">
        <EmptyState title={t("set.noConfigFound")} />
      </section>
    );

  const update = (next: ProviderConfiguration) => {
    setDrafts((old) => ({ ...old, [provider]: next }));
    setNote(null);
  };

  const discard = () => {
    setDrafts((old) => ({
      ...old,
      [provider]: structuredClone(data.document.providers[provider]),
    }));
    setEditedDefaults((old) => ({ ...old, [provider]: [] }));
    setNote(null);
  };

  const setRoleField = (scope: string, role: string, key: keyof AgentValues, val: unknown) => {
    const currentRole = { ...(draft.profiles[scope]?.[role] ?? {}) };
    if (val === undefined) delete currentRole[key];
    else Object.assign(currentRole, { [key]: val });
    const nextProfiles = pruneProfiles({
      ...draft.profiles,
      [scope]: {
        ...draft.profiles[scope],
        [role]: currentRole,
      },
    });
    update({
      ...draft,
      profiles: nextProfiles,
    });
  };

  const resetRole = (scope: string, role: string) => {
    const nextScope = { ...(draft.profiles[scope] ?? {}) };
    delete nextScope[role];
    update({
      ...draft,
      profiles: pruneProfiles({
        ...draft.profiles,
        [scope]: nextScope,
      }),
    });
  };

  const currentCatalog = catalog.data?.find((entry) => entry.id === provider);
  const controls = currentCatalog?.controls ?? data.controls[provider];
  const scopeLabel = (s: string) => (s === "*" ? t("set.routingAny") : s);

  return (
    <section className="card set-section agent-settings-card" id="set-agents">
      <header className="set-section-head agent-section-head">
        <Bot size={18} aria-hidden />
        <h3>{t("set.agentConfiguration")}</h3>
        <div className="agent-head-actions">
          {dirty ? (
            <span className="set-flag is-dirty">{t("set.flagUnsaved")}</span>
          ) : (
            <span className="set-flag is-saved">{t("set.flagSaved")}</span>
          )}
          {dirty && (
            <Button variant="secondary" size="sm" disabled={busy} onClick={discard}>
              <RotateCcw size={13} aria-hidden /> {t("set.discard")}
            </Button>
          )}
          <Button size="sm" loading={busy} onClick={() => void save()}>
            {t("set.saveProvider")}
          </Button>
        </div>
      </header>

      <div className="agent-top-row">
        <p className="muted small set-lead">
          {t("set.agentSubtitle")
            .split(/\{link\}/)
            .map((part, i) =>
              i === 0 ? (
                part
              ) : (
                <span key={i}>
                  <a href="#/integrations">{t("nav.integrations")}</a>
                  {part}
                </span>
              ),
            )}
        </p>
        <div className="agent-default-provider-field">
          <Field label={t("set.provider")}>
            <select
              aria-label={t("set.provider")}
              value={data.document.default_provider}
              disabled={busy}
              onChange={async (event) => {
                setBusy(true);
                setNote(null);
                try {
                  setData(
                    await api<View>("/api/settings/agents/default", {
                      provider: event.target.value,
                      revision: data.document.default_revision ?? 0,
                    }),
                  );
                  setNote({ text: t("set.defaultProviderUpdated"), ok: true });
                } catch (err) {
                  setNote({ text: (err as Error).message, ok: false });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {Object.entries(data.document.providers)
                .filter(([, entry]) => entry.enabled)
                .map(([key]) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
            </select>
          </Field>
        </div>
      </div>

      <div role="tablist" aria-label={t("set.providers")} className="agent-provider-tabs">
        {Object.keys(data.document.providers).map((key) => {
          const providerDirty = isProviderDirty(key);
          const isEnabled = (drafts[key] ?? data.document.providers[key])?.enabled;
          return (
            <Button
              key={key}
              size="sm"
              role="tab"
              aria-selected={provider === key}
              variant={provider === key ? "primary" : "secondary"}
              className={`agent-provider-tab${!isEnabled ? " is-disabled-provider" : ""}`}
              onClick={() => {
                setProvider(key);
                setNote(null);
                setPreview({});
              }}
            >
              {key}
              {providerDirty && <i className="set-dot is-dirty" aria-hidden="true" />}
            </Button>
          );
        })}
      </div>

      <div className="agent-provider-panel">
        <div className="agent-provider-bar">
          <label className="set-toggle agent-enable-label">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => update({ ...draft, enabled: event.target.checked })}
            />
            <span>{t("set.enableProvider", { provider })}</span>
          </label>
          <p className="small muted agent-discovery-meta">
            {t("set.modelDiscovery")} <b>{currentCatalog?.discovery ?? "loading"}</b> ·{" "}
            {currentCatalog?.cache ?? "no cache"}
            {currentCatalog?.discovered_at ? ` · ${currentCatalog.discovered_at}` : ""}. Saved
            selections remain available when discovery fails.
          </p>
        </div>

        <div className="agent-defaults-card">
          <div className="agent-subhead">
            <h4>{t("set.providerDefaults")}</h4>
            <span className="muted small">
              {t("set.providerDefaultsHint")}
            </span>
          </div>
          <AgentValueFields
            label={t("set.defaultLabel")}
            value={draft.defaults}
            controls={controls}
            models={currentCatalog?.models}
            discovery={currentCatalog?.discovery}
            onChange={(defaults) => {
              const changed = changedDefaultFields(draft.defaults, defaults);
              setEditedDefaults((old) => ({
                ...old,
                [provider]: [...new Set([...(old[provider] ?? []), ...changed])],
              }));
              update({ ...draft, defaults });
            }}
          />
        </div>

        <div className="agent-profiles-card">
          <div className="agent-subhead">
            <h4>{t("set.modelRouting")}</h4>
            <p className="muted small agent-profiles-guide">
              {t("set.modelRoutingLead")}
            </p>
          </div>

          <div role="tablist" aria-label={t("set.routingProfile")} className="agent-profile-tabs">
            {data.scopes.map((scope) => {
              const label = scopeLabel(scope);
              const overrideCount = countScopeOverrides(draft.profiles[scope], data.roles);
              const isSelected = activeScope === scope;
              return (
                <button
                  key={scope}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  aria-label={label}
                  className={`agent-profile-tab${isSelected ? " is-active" : ""}${overrideCount > 0 ? " is-customized" : ""}`}
                  onClick={() => setActiveScope(scope)}
                  data-tip={
                    overrideCount > 0
                      ? `${label}: ${t("set.overridesCount", { n: overrideCount })}`
                      : `${label}: ${t("set.inheritingAll")}`
                  }
                >
                  <span>{label}</span>
                  {overrideCount > 0 && (
                    <span className="agent-tab-badge" aria-hidden="true">
                      {overrideCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div
            className="table-wrap agent-role-table-wrap"
            role="tabpanel"
            aria-label={`${scopeLabel(activeScope)} role configuration`}
          >
            <table className="agent-role-table">
              <thead>
                <tr>
                  <th scope="col" className="col-role">
                    {t("set.role")}
                  </th>
                  <th scope="col" className="col-model">
                    {t("set.model")}
                  </th>
                  <th scope="col" className="col-effort">
                    {t("set.effort")}
                  </th>
                  <th scope="col" className="col-timeout">
                    {t("set.timeoutMs")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.roles.map((role) => {
                  const roleValues = draft.profiles[activeScope]?.[role] ?? {};
                  const overrideCount = countRoleOverrides(roleValues);
                  const isOverridden = overrideCount > 0;
                  const effective = preview[`${activeScope}/${role}`];
                  const effectiveSummary = effective
                    ? Object.entries(effective.sources)
                        .filter(([key]) => key !== "options")
                        .map(([key, source]) => {
                          const val = key.startsWith("options.")
                            ? effective.values.options?.[
                                key.slice(8) as "sandbox" | "max_concurrent"
                              ]
                            : effective.values[key as keyof AgentValues];
                          return `${key}: ${String(val ?? "account/CLI default")} (${source})`;
                        })
                        .join(" · ")
                    : "";
                  const efforts = resolveSupportedEfforts(
                    controls,
                    currentCatalog?.models,
                    roleValues.model ?? effective?.values.model,
                  );

                  return (
                    <tr
                      className={`agent-profile-role${isOverridden ? " is-overridden" : ""}`}
                      key={`${activeScope}/${role}`}
                      data-tip={effectiveSummary || undefined}
                    >
                      <td className="agent-role-cell">
                        <div className="agent-role-title-row">
                          <span className="agent-role-name">{t(`set.role.${role}`) || role}</span>
                          <span
                            className={`agent-role-badge${isOverridden ? " is-overridden" : ""}`}
                          >
                            {isOverridden ? t("set.roleOverridden") : t("set.roleInheriting")}
                          </span>
                          {isOverridden && (
                            <button
                              type="button"
                              className="ghost xs agent-role-reset"
                              onClick={() => resetRole(activeScope, role)}
                              title={t("set.resetRoleInherit")}
                            >
                              {t("set.reset")}
                            </button>
                          )}
                        </div>
                        {effective && (
                          <div className="agent-eff-pills">
                            <span
                              className="agent-eff-pill"
                              data-tip={`model: ${String(effective.values.model ?? "account/CLI default")} (${effective.sources.model})`}
                            >
                              model: <b>{effective.values.model ?? t("set.cliDefaultOnly")}</b>
                            </span>
                            {!!efforts.length && (
                              <span
                                className="agent-eff-pill"
                                data-tip={`reasoning_effort: ${String(effective.values.reasoning_effort ?? "account/CLI default")} (${effective.sources.reasoning_effort})`}
                              >
                                effort: <b>{effective.values.reasoning_effort ?? t("set.cliDefaultOnly")}</b>
                              </span>
                            )}
                            <span
                              className="agent-eff-pill"
                              data-tip={`timeout_ms: ${String(effective.values.timeout_ms ?? "account/CLI default")} (${effective.sources.timeout_ms})`}
                            >
                              timeout:{" "}
                              <b>
                                {effective.values.timeout_ms
                                  ? `${effective.values.timeout_ms}ms`
                                  : t("set.cliDefaultOnly")}
                              </b>
                            </span>
                          </div>
                        )}
                      </td>

                      <td className="agent-model-cell">
                        {controls?.model !== false ? (
                          <ModelCombobox
                            ariaLabel={`${activeScope}/${role} model`}
                            value={roleValues.model}
                            models={currentCatalog?.models}
                            discovery={currentCatalog?.discovery}
                            placeholder={t("set.routingInherit")}
                            onChange={(model) => setRoleField(activeScope, role, "model", model)}
                          />
                        ) : roleValues.model ? (
                          <small className="set-warn">
                            {t("set.unsupportedByCli", { model: roleValues.model })}
                          </small>
                        ) : (
                          <span className="muted small">{t("set.cliDefaultOnly")}</span>
                        )}
                      </td>

                      <td className="agent-effort-cell">
                        {efforts.length > 0 ? (
                          <select
                            aria-label={`${activeScope}/${role} reasoning effort`}
                            className={
                              roleValues.reasoning_effort !== undefined ? "is-overridden" : ""
                            }
                            value={
                              roleValues.reasoning_effort === null
                                ? "__account__"
                                : (roleValues.reasoning_effort ?? "")
                            }
                            onChange={(event) =>
                              setRoleField(
                                activeScope,
                                role,
                                "reasoning_effort",
                                event.target.value === "__account__"
                                  ? null
                                  : event.target.value || undefined,
                              )
                            }
                          >
                            <option value="">{t("set.routingInherit")}</option>
                            <option value="__account__">{t("set.modelAccount")}</option>
                            {roleValues.reasoning_effort &&
                              !efforts.includes(roleValues.reasoning_effort) && (
                                <option value={roleValues.reasoning_effort}>
                                  {roleValues.reasoning_effort} (saved; unavailable)
                                </option>
                              )}
                            {efforts.map((effort) => (
                              <option key={effort} value={effort}>
                                {effort}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <select
                            aria-label={`${activeScope}/${role} reasoning effort`}
                            disabled
                            value=""
                          >
                            <option value="">{t("set.inheritUnsupported")}</option>
                          </select>
                        )}
                      </td>

                      <td className="agent-timeout-cell">
                        <input
                          aria-label={`${activeScope}/${role} timeout (ms)`}
                          className={roleValues.timeout_ms !== undefined ? "is-overridden" : ""}
                          type="number"
                          min={1000}
                          max={86400000}
                          step={1000}
                          value={roleValues.timeout_ms ?? ""}
                          placeholder={
                            effective?.values.timeout_ms !== undefined
                              ? String(effective.values.timeout_ms)
                              : t("set.routingInherit")
                          }
                          onChange={(event) =>
                            setRoleField(
                              activeScope,
                              role,
                              "timeout_ms",
                              event.target.value ? Number(event.target.value) : undefined,
                            )
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className={`agent-savebar${dirty || note ? " is-visible" : ""}`}>
        <p
          role="status"
          aria-live="polite"
          className={`agent-savebar-status${note ? (note.ok ? " is-ok" : " is-error") : ""}`}
        >
          {note ? note.text : dirty ? t("set.unsavedProvider", { provider }) : ""}
        </p>
        {dirty && (
          <div className="agent-head-actions">
            <Button variant="secondary" size="sm" disabled={busy} onClick={discard}>
              {t("set.discard")}
            </Button>
            <Button size="sm" loading={busy} onClick={() => void save()}>
              {t("common.save")}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
