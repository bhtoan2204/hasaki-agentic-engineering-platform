import { useState } from "react";
import { GitPullRequest, KeyRound, LogOut, Plus, Trash2 } from "lucide-react";
import { api, useApi } from "../../api.ts";
import { dialog } from "../../dialog/index.ts";
import { act, Field } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { Row } from "./shared.tsx";

/**
 * Per-instance GitLab access token (personal or project access token). The host must be one of the allowed instances,
 * which an admin adds here (stored in the database); the token is never shown again, only whether one is saved.
 */
export function GitLabAccount(p: { open: boolean; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  const { data: st, reload } = useApi<{
    instances: Array<{
      host: string;
      base_url: string;
      configured: boolean;
      personal: boolean;
      ssh_available: boolean;
      ssh_key: boolean;
    }>;
    can_manage?: boolean;
  }>("/api/integrations/gitlab");
  const [newHost, setNewHost] = useState("");
  const [host, setHost] = useState("");
  const [token, setToken] = useState("");
  const [sshKey, setSshKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; kind: string; message: string } | null>(null);
  const instances = st?.instances ?? [];
  const selected = host || instances[0]?.host || "";
  const current = instances.find((i) => i.host === selected);
  const connected = instances.filter((i) => i.configured);
  const save = async () => {
    setBusy(true);
    setCheck(null);
    const r = await act(
      () => api<unknown>("/api/integrations/gitlab", { host: selected, token }),
      t("ig.gl.saved"),
    );
    setBusy(false);
    if (r) {
      setToken("");
      reload();
    }
  };
  const saveSsh = async () => {
    setBusy(true);
    const r = await act(
      () => api<unknown>("/api/integrations/gitlab/ssh-key", { host: selected, ssh_key: sshKey }),
      t("ig.gl.sshSaved"),
    );
    setBusy(false);
    if (r) {
      setSshKey("");
      reload();
    }
  };
  const addInstance = async () => {
    setBusy(true);
    const r = await act(
      () =>
        api<{ instances: Array<{ host: string }> }>("/api/integrations/gitlab/instances", {
          host: newHost,
        }),
      t("ig.gl.instanceAdded"),
    );
    setBusy(false);
    if (r) {
      const added = r.instances.find((i) => !instances.some((x) => x.host === i.host));
      setNewHost("");
      if (added) setHost(added.host);
      setCheck(null);
      reload();
    }
  };
  const removeInstance = async () => {
    if (!selected) return;
    const ok = await dialog.confirm({
      title: t("ig.gl.instanceRemove.title"),
      description: t("ig.gl.instanceRemoveConfirm", { host: selected }),
      confirmLabel: t("ig.gl.instanceRemove.action"),
      cancelLabel: t("common.cancel"),
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    const r = await act(
      () => api("/api/integrations/gitlab/instances/remove", { host: selected }),
      t("ig.removed"),
    );
    setBusy(false);
    if (r) {
      setHost("");
      setCheck(null);
      reload();
    }
  };
  const test = async () => {
    setBusy(true);
    const r = await act(() =>
      api<{ ok: boolean; kind: string; message: string }>("/api/integrations/gitlab/test", {
        host: selected,
      }),
    );
    setBusy(false);
    if (r) setCheck(r);
  };
  return (
    <Row
      id="gitlab"
      icon={GitPullRequest}
      title="GitLab"
      health={!st ? "loading" : connected.length ? "ok" : "off"}
      {...p}
      summary={connected.length ? connected.map((i) => i.host).join(", ") : t("ig.gl.summaryOff")}
    >
      <p className="muted small">{t("ig.gl.body")}</p>
      <Field group label={t("ig.gl.instance")} hint={t("ig.gl.instanceHint")}>
        <span className="ig-gl-instance">
          <select value={selected} onChange={(e) => (setHost(e.target.value), setCheck(null))}>
            {instances.map((i) => (
              <option key={i.host} value={i.host}>
                {i.base_url}
                {i.personal ? ` · ${t("ig.gl.saved")}` : ""}
              </option>
            ))}
          </select>
          {st?.can_manage && selected && (
            <button
              type="button"
              className="sm ghost"
              disabled={busy}
              title={t("ig.gl.instanceRemove")}
              aria-label={t("ig.gl.instanceRemove")}
              onClick={removeInstance}
            >
              <Trash2 size={14} strokeWidth={2} />
            </button>
          )}
        </span>
      </Field>
      {st?.can_manage && (
        <Field group label={t("ig.gl.instanceAdd")} hint={t("ig.gl.instanceAddHint")}>
          <span className="ig-gl-instance">
            <input
              value={newHost}
              autoComplete="off"
              placeholder="https://gitlab.example.com"
              onChange={(e) => setNewHost(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && newHost.trim() && addInstance()}
            />
            <button
              type="button"
              className="sm ghost"
              disabled={busy || !newHost.trim()}
              aria-describedby={!newHost.trim() ? "ig-h5" : undefined}
              onClick={addInstance}
            >
              <Plus size={14} strokeWidth={2} />
              {t("ig.gl.instanceAddButton")}
            </button>
            {!newHost.trim() && (
              <span id="ig-h5" className="muted small">
                {t("hint.fillRequired")}
              </span>
            )}
          </span>
        </Field>
      )}
      <Field label={t("ig.gl.token")}>
        <input
          type="password"
          autoComplete="off"
          value={token}
          placeholder={current?.personal ? t("ig.keep") : "glpat-…"}
          onChange={(e) => setToken(e.target.value)}
        />
      </Field>
      {current?.ssh_available && (
        <Field group label={t("ig.gl.sshKey")} hint={t("ig.gl.sshKeyHint")}>
          <textarea
            rows={3}
            autoComplete="off"
            spellCheck={false}
            value={sshKey}
            placeholder={current.ssh_key ? t("ig.keep") : "-----BEGIN OPENSSH PRIVATE KEY-----"}
            onChange={(e) => setSshKey(e.target.value)}
          />
          <button
            type="button"
            className="sm ghost"
            disabled={busy || !sshKey}
            aria-describedby={!sshKey ? "ig-h6" : undefined}
            onClick={saveSsh}
          >
            <KeyRound size={14} strokeWidth={2} />
            {t("ig.gl.sshSave")}
          </button>
          {!sshKey && (
            <span id="ig-h6" className="muted small">
              {t("hint.fillRequired")}
            </span>
          )}
        </Field>
      )}
      {check && (
        <p className={`small ${check.ok ? "" : "error"}`}>
          {check.ok ? "✓ " : `${t(`ig.gl.err.${check.kind}`)}: `}
          {check.message}
        </p>
      )}
      <div className="ig-actions">
        <button
          type="button"
          className="sm"
          disabled={busy || !token || !selected}
          aria-describedby={!token || !selected ? "ig-h7" : undefined}
          onClick={save}
        >
          <KeyRound size={14} strokeWidth={2} />
          {busy ? t("ig.checking") : t("ig.save")}
        </button>
        {!token ||
          (!selected && (
            <span id="ig-h7" className="muted small">
              {t("hint.fillRequired")}
            </span>
          ))}
        <button
          type="button"
          className="sm ghost"
          disabled={busy || !current?.configured}
          onClick={test}
        >
          {t("ig.gl.test")}
        </button>
        {current?.personal && (
          <button
            type="button"
            className="sm ghost"
            onClick={async () => {
              const ok = await act(
                () => api("/api/integrations/gitlab/clear", { host: selected }),
                t("ig.removed"),
              );
              if (!ok) return;
              setToken("");
              setCheck(null);
              reload();
            }}
          >
            <LogOut size={14} strokeWidth={2} />
            {t("ig.removePlatform")}
          </button>
        )}
      </div>
    </Row>
  );
}
