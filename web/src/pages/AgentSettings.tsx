import { useEffect, useState } from "react";
import { api, useApi } from "../api.ts";
import { changedDefaultFields, providerDraftPatch } from "../agentConfiguration.ts";
import {
  AgentValueFields,
  type AgentValues,
  type AgentControls,
  type AgentCatalogModel,
} from "../AgentValueFields.tsx";
import { Button, ErrorBox, Field } from "../ui.tsx";

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

export function AgentSettings() {
  const { data, error, setData } = useApi<View>("/api/settings/agents");
  const catalog = useApi<Catalog[]>("/api/agent-providers");
  const [provider, setProvider] = useState("claude");
  const [drafts, setDrafts] = useState<Record<string, ProviderConfiguration>>({});
  const [editedDefaults, setEditedDefaults] = useState<Record<string, string[]>>({});
  const [note, setNote] = useState("");
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
            old[key] ?? structuredClone(entry),
          ]),
        ),
      );
  }, [data]);
  const draft = drafts[provider];
  const defaultFields = editedDefaults[provider];
  useEffect(() => {
    if (!data || !draft) return;
    let active = true;
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
                draft: providerDraftPatch(draft, defaultFields ?? []),
              },
            );
            return [`${scope}/${role}`, result] as const;
          }),
        ),
      )
        .then((entries) => {
          if (active) setPreview(Object.fromEntries(entries));
        })
        .catch((error: Error) => {
          if (active) setNote(error.message);
        });
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [data, draft, provider, defaultFields]);
  if (error) return <ErrorBox error={error} />;
  if (!data || !draft)
    return (
      <section className="card">
        <h3>Provider configuration</h3>
        <p>Loading configuration…</p>
      </section>
    );
  const update = (next: ProviderConfiguration) => {
    setDrafts((old) => ({ ...old, [provider]: next }));
    setNote("");
  };
  const currentCatalog = catalog.data?.find((entry) => entry.id === provider);
  const controls = currentCatalog?.controls ?? data.controls[provider];
  const save = async () => {
    setBusy(true);
    setNote("");
    try {
      const next = await api<View>("/api/settings/agents/provider", {
        provider,
        revision: draft.revision,
        patch: providerDraftPatch(draft, defaultFields ?? []),
      });
      setData(next);
      setDrafts((old) => ({
        ...old,
        [provider]: structuredClone(next.document.providers[provider]),
      }));
      setEditedDefaults((old) => ({ ...old, [provider]: [] }));
      setNote("Provider saved");
    } catch (error) {
      setNote((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card set-section" id="set-agents">
      <h3>Provider configuration</h3>
      <p className="muted small">
        Saved values apply to new runs. Active runs retain their configuration snapshot. Manage
        account authentication in <a href="#/integrations">Integrations</a>.
      </p>
      <Field label="Default provider">
        <select
          aria-label="Default provider"
          value={data.document.default_provider}
          disabled={busy}
          onChange={async (event) => {
            setBusy(true);
            try {
              setData(
                await api<View>("/api/settings/agents/default", {
                  provider: event.target.value,
                  revision: data.document.default_revision ?? 0,
                }),
              );
            } catch (error) {
              setNote((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {Object.entries(data.document.providers)
            .filter(([, entry]) => entry.enabled)
            .map(([key]) => (
              <option key={key}>{key}</option>
            ))}
        </select>
      </Field>
      <div role="tablist" aria-label="Agent providers" className="set-chips">
        {Object.keys(data.document.providers).map((key) => (
          <Button
            key={key}
            role="tab"
            aria-selected={provider === key}
            variant={provider === key ? "primary" : "secondary"}
            onClick={() => {
              setProvider(key);
              setNote("");
              setPreview({});
            }}
          >
            {key}
          </Button>
        ))}
      </div>
      <label>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => update({ ...draft, enabled: event.target.checked })}
        />{" "}
        Enable {provider}
      </label>
      <p className="small muted">
        Model discovery: {currentCatalog?.discovery ?? "loading"} ·{" "}
        {currentCatalog?.cache ?? "no cache"}
        {currentCatalog?.discovered_at ? ` · ${currentCatalog.discovered_at}` : ""}. Saved
        selections remain available when discovery fails.
      </p>
      <AgentValueFields
        label="Default"
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
      <h4>Models and execution options by profile and role</h4>
      {data.scopes.map((scope) => (
        <details key={scope} open>
          <summary>{scope === "*" ? "ANY PROFILE" : scope}</summary>
          {data.roles.map((role) => {
            const effective = preview[`${scope}/${role}`];
            return (
              <div className="agent-profile-role" key={role}>
                <h5>
                  {{
                    agent: "Analysis / Architecture",
                    coding_agent: "Coding",
                    verifier: "Independent Verification",
                  }[role] ?? role}
                </h5>
                <AgentValueFields
                  label={`${scope}/${role}`}
                  value={draft.profiles[scope]?.[role] ?? {}}
                  controls={controls}
                  models={currentCatalog?.models}
                  discovery={currentCatalog?.discovery}
                  onChange={(values) =>
                    update({
                      ...draft,
                      profiles: {
                        ...draft.profiles,
                        [scope]: { ...draft.profiles[scope], [role]: values },
                      },
                    })
                  }
                />
                {effective && (
                  <p className="small muted">
                    {Object.entries(effective.sources)
                      .filter(([key]) => key !== "options")
                      .map(
                        ([key, source]) =>
                          `${key}: ${String((key.startsWith("options.") ? effective.values.options?.[key.slice(8) as "sandbox" | "max_concurrent"] : effective.values[key as keyof AgentValues]) ?? "account/CLI default")} (${source})`,
                      )
                      .join(" · ")}
                  </p>
                )}
              </div>
            );
          })}
        </details>
      ))}
      <Button loading={busy} onClick={() => void save()}>
        Save provider
      </Button>
      <p role="status">{note}</p>
    </section>
  );
}
