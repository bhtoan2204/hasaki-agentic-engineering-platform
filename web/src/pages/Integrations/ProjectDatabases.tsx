import { useCallback, useEffect, useRef, useState } from "react";
import { Database, RefreshCw } from "lucide-react";
import { api, useApi } from "../../api.ts";
import { dialog } from "../../dialog/index.ts";
import { act, Field } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { DbCard } from "./DbCard.tsx";
import {
  type DbForm,
  type DbInfo,
  EMPTY_DB,
  type Health,
  Row,
  STALE_MS,
  dbState,
} from "./shared.tsx";

/**
 * Read-only MySQL QC databases per project. Agents query them through the platform tools (database.list / schema /
 * query) only when their run's repository scope covers the database's project or repositories. The status shown is the
 * last real connection (admin test, automatic re-check, or an agent query), never just "configured".
 */
export function ProjectDatabases(p: {
  open: boolean;
  onToggle: (id: string) => void;
  isAdmin: boolean;
}) {
  const { t } = useI18n();
  const { data, reload } = useApi<DbInfo[]>("/api/integrations/databases");
  const [form, setForm] = useState<DbForm | null>(null);
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const list = data ?? [];
  const enabled = list.filter((d) => d.enabled !== false);
  const states = enabled.map((d) => dbState(d, checking));
  const health: Health = !data
    ? "loading"
    : !enabled.length
      ? "off"
      : states.some((s) => s === "failed")
        ? "error"
        : states.every((s) => s === "ok")
          ? "ok"
          : "partial";
  const test = useCallback(
    async (keys: string[]) => {
      if (!keys.length) return;
      setChecking((c) => new Set([...c, ...keys]));
      // A failed connection is a result (ok: false), shown on the card, not an error toast.
      await Promise.all(
        keys.map((k) => api(`/api/integrations/databases/${k}/test`, {}).catch(() => null)),
      );
      setChecking((c) => new Set([...c].filter((k) => !keys.includes(k))));
      reload();
    },
    [reload],
  );
  // Loading the page re-checks databases never checked or checked more than five minutes ago (admins only), so the
  // lights in the collapsed row are current before anyone opens it.
  const autoChecked = useRef(false);
  useEffect(() => {
    if (!p.isAdmin || !data || autoChecked.current) return;
    autoChecked.current = true;
    const stale = data
      .filter((d) => d.enabled !== false && d.has_password)
      .filter(
        (d) => !d.last_checked_at || Date.now() - new Date(d.last_checked_at).getTime() > STALE_MS,
      )
      .map((d) => d.key);
    void test(stale);
  }, [p.isAdmin, data, test]);
  const set = (k: keyof DbForm, v: DbForm[keyof DbForm]) => {
    if (form) setForm({ ...form, [k]: v });
  };
  const save = async () => {
    if (!form) return;
    const body = {
      ...Object.fromEntries(
        Object.entries(form).filter(
          ([k]) =>
            !k.startsWith("last_") &&
            !["id", "has_password", "updated_at", "created_at", "created_by"].includes(k),
        ),
      ),
      port: Number(form.port),
      max_rows: Number(form.max_rows),
      timeout_ms: Number(form.timeout_ms),
      repositories: String(form.repositories)
        .split(",")
        .map((x: string) => x.trim())
        .filter(Boolean),
      password: form.password || undefined,
    };
    const r = await act(
      () => api<{ key: string }>("/api/integrations/databases", body),
      t("ig.db.saved"),
    );
    if (r) {
      setForm(null);
      reload();
      void test([r.key]); // check the new settings right away
    }
  };
  const summary = !enabled.length ? (
    t("ig.db.summaryOff")
  ) : (
    <span className="ig-db-summary">
      {enabled.map((d, i) => (
        <span key={d.key} className={`ig-db-sum is-${states[i]}`}>
          <span className="ig-db-light" aria-hidden />
          {d.key}
        </span>
      ))}
    </span>
  );
  return (
    <Row
      id="databases"
      icon={Database}
      title={t("ig.db.title")}
      env="QC"
      health={health}
      {...p}
      summary={summary}
    >
      <p className="muted small">{t("ig.db.body")}</p>
      {!list.length ? (
        <p className="muted small">{t(p.isAdmin ? "ig.db.emptyAdmin" : "ig.db.emptyMember")}</p>
      ) : (
        <div className="ig-db-cards">
          {list.map((d) => (
            <DbCard
              key={d.key}
              d={d}
              state={dbState(d, checking)}
              isAdmin={p.isAdmin}
              onTest={() => void test([d.key])}
              onEdit={() =>
                setForm({
                  ...EMPTY_DB,
                  ...d,
                  repositories: (d.repositories ?? []).join(", "),
                  password: "",
                })
              }
              onDelete={async () => {
                const ok = await dialog.confirm({
                  title: t("ig.db.delete.title"),
                  description: t("ig.db.deleteConfirm", { key: d.key }),
                  confirmLabel: t("ig.db.delete.action"),
                  cancelLabel: t("common.cancel"),
                  variant: "destructive",
                });
                if (!ok) return;
                if (
                  await act(
                    () => api(`/api/integrations/databases/${d.key}/delete`, {}),
                    t("ig.db.deleted"),
                  )
                )
                  reload();
              }}
            />
          ))}
        </div>
      )}
      {p.isAdmin && !form && (
        <div className="row">
          <button type="button" className="sm" onClick={() => setForm({ ...EMPTY_DB })}>
            <Database size={14} /> {t("ig.db.add")}
          </button>
          {enabled.length > 1 && (
            <button
              type="button"
              className="sm ghost"
              onClick={() => void test(enabled.filter((d) => d.has_password).map((d) => d.key))}
            >
              <RefreshCw size={14} /> {t("ig.db.checkAll")}
            </button>
          )}
        </div>
      )}
      {p.isAdmin && form && (
        <div className="ig-db-form">
          <div className="ig-db-grid">
            <Field label={t("ig.db.key")}>
              <input
                value={form.key}
                placeholder="oms-qc"
                onChange={(e) => set("key", e.target.value.trim().toLowerCase())}
              />
            </Field>
            <Field label={t("ig.db.project")}>
              <input
                value={form.project}
                placeholder="OMS"
                onChange={(e) => set("project", e.target.value)}
              />
            </Field>
            <Field label={t("ig.db.repositories")}>
              <input
                value={form.repositories}
                placeholder="warranty-api, warranty-worker"
                onChange={(e) => set("repositories", e.target.value)}
              />
            </Field>
            <Field label={t("ig.db.host")}>
              <input
                value={form.host}
                placeholder="oms-db.qc.internal"
                onChange={(e) => set("host", e.target.value.trim())}
              />
            </Field>
            <Field label={t("ig.db.port")}>
              <input
                type="number"
                value={form.port}
                onChange={(e) => set("port", e.target.value)}
              />
            </Field>
            <Field label={t("ig.db.database")}>
              <input
                value={form.database_name}
                onChange={(e) => set("database_name", e.target.value.trim())}
              />
            </Field>
            <Field label={t("ig.db.username")}>
              <input
                value={form.username}
                autoComplete="off"
                onChange={(e) => set("username", e.target.value.trim())}
              />
            </Field>
            <Field label={t("ig.db.password")}>
              <input
                type="password"
                autoComplete="new-password"
                value={form.password}
                placeholder={form.has_password ? t("ig.db.passwordKeep") : ""}
                onChange={(e) => set("password", e.target.value)}
              />
            </Field>
            <Field label={t("ig.db.maxRows")}>
              <input
                type="number"
                value={form.max_rows}
                onChange={(e) => set("max_rows", e.target.value)}
              />
            </Field>
            <Field label={t("ig.db.timeout")}>
              <input
                type="number"
                value={form.timeout_ms}
                onChange={(e) => set("timeout_ms", e.target.value)}
              />
            </Field>
          </div>
          <Field label={t("ig.db.description")}>
            <input value={form.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
          <label className="small">
            <input
              type="checkbox"
              checked={form.ssl}
              onChange={(e) => set("ssl", e.target.checked)}
            />{" "}
            TLS
          </label>{" "}
          <label className="small">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => set("enabled", e.target.checked)}
            />{" "}
            {t("ig.db.enabled")}
          </label>
          <p className="muted small">{t("ig.db.scopeHint")}</p>
          <div className="row">
            <button type="button" className="sm" onClick={save}>
              {t("common.save")}
            </button>
            <button type="button" className="sm ghost" onClick={() => setForm(null)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </Row>
  );
}
