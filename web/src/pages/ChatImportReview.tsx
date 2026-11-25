import { useEffect, useState } from "react";
import { BookPlus } from "lucide-react";
import { api } from "../api.ts";
import { act } from "../ui.tsx";
import { useI18n } from "../i18n/index.tsx";

/** One proposal of a chat document import (the knowledge.propose_import result). */
export interface ImportedProposal {
  candidate_id: string;
  action: string;
  proposal_id?: number | null;
  key?: string;
  title?: string;
  category?: string;
  scope?: string;
  source?: { filename: string; locations: string[] };
  existing?: string;
  error?: string;
}

type Row = ImportedProposal & {
  selected: boolean;
  title: string;
  scopeType: string;
  scopeRef: string;
  status: string;
};

const parseScope = (scope = "") => {
  const [type, ...ref] = scope.split(" ");
  return { scopeType: type || "GLOBAL", scopeRef: ref.join(" ") };
};

/**
 * Review card of a document import, inside the conversation: select proposals, edit their title or scope, approve or
 * reject them through the existing knowledge proposal API (the server applies the reviewer and sharing rules).
 */
export function ChatImportReview({
  scope,
  proposals,
  errors,
}: {
  scope: string;
  proposals: ImportedProposal[];
  errors: Array<{ filename: string; error: string }>;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<Row[]>(() =>
    proposals.map((p) => ({
      ...p,
      selected: !!p.proposal_id,
      title: p.title ?? p.key ?? p.candidate_id,
      ...parseScope(p.scope),
      status: p.proposal_id ? "pending" : p.action,
    })),
  );
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  // The current status of each proposal (it may have been reviewed elsewhere since).
  useEffect(() => {
    let live = true;
    for (const p of proposals)
      if (p.proposal_id)
        void api<{ status: string }>(`/api/knowledge-proposals/${p.proposal_id}`)
          .then(
            (r) =>
              live &&
              setRows((cur) =>
                cur.map((x) => (x.proposal_id === p.proposal_id ? { ...x, status: r.status } : x)),
              ),
          )
          .catch(() => {});
    return () => {
      live = false;
    };
  }, [proposals]);
  const patch = (id: number | null | undefined, change: Partial<Row>) =>
    setRows((cur) => cur.map((x) => (x.proposal_id === id ? { ...x, ...change } : x)));

  const decide = async (decision: "approve" | "reject", only?: Row) => {
    setBusy(true);
    try {
      for (const r of only ? [only] : rows.filter((x) => x.selected && x.status === "pending")) {
        const ok = await act(() =>
          api(
            `/api/knowledge-proposals/${r.proposal_id}/${decision}`,
            decision === "approve"
              ? {
                  shared,
                  edits: {
                    title: r.title,
                    scope_type: r.scopeType,
                    scope_ref: r.scopeType === "GLOBAL" ? "" : r.scopeRef,
                  },
                }
              : { comment: "rejected from the chat import" },
          ),
        );
        if (ok !== undefined)
          patch(r.proposal_id, {
            status: decision === "approve" ? "approved" : "rejected",
            selected: false,
          });
      }
    } finally {
      setBusy(false);
    }
  };

  const pending = rows.filter((r) => r.status === "pending");
  return (
    <div className="chat-import" role="region" aria-label={t("chat.import.title", { scope })}>
      <div className="chat-import-head">
        <BookPlus size={16} />
        <b>{t("chat.import.title", { scope })}</b>
        <span className="muted">{t("chat.import.count", { n: rows.length })}</span>
      </div>
      <ul>
        {rows.map((r) => (
          <li key={r.candidate_id}>
            <label className="chat-import-pick">
              <input
                type="checkbox"
                checked={r.selected}
                disabled={r.status !== "pending"}
                onChange={(e) => patch(r.proposal_id, { selected: e.target.checked })}
                aria-label={r.title}
              />
            </label>
            <div className="chat-import-body">
              {r.status === "pending" ? (
                <input
                  className="chat-import-title"
                  value={r.title}
                  onChange={(e) => patch(r.proposal_id, { title: e.target.value })}
                  aria-label={t("chat.import.editTitle")}
                />
              ) : (
                <b>{r.title}</b>
              )}
              <small>
                {r.category ?? "—"} · {r.status}
                {r.existing ? ` · ${r.existing}` : ""}
                {r.error ? ` · ${r.error}` : ""}
              </small>
              {r.source && (
                <small className="muted">
                  {r.source.filename}: {r.source.locations.join(", ")}
                </small>
              )}
              {r.status === "pending" && (
                <span className="chat-import-scope">
                  <select
                    value={r.scopeType}
                    onChange={(e) => patch(r.proposal_id, { scopeType: e.target.value })}
                    aria-label={t("chat.import.scope")}
                  >
                    <option value="PROJECT">PROJECT</option>
                    <option value="REPOSITORY">REPOSITORY</option>
                    <option value="GLOBAL">{t("chat.import.personalOrGlobal")}</option>
                  </select>
                  {r.scopeType !== "GLOBAL" && (
                    <input
                      value={r.scopeRef}
                      onChange={(e) => patch(r.proposal_id, { scopeRef: e.target.value })}
                      aria-label={t("chat.import.scopeRef")}
                    />
                  )}
                  <a href="#/knowledge/~proposals">{t("chat.import.open")}</a>
                  <button
                    type="button"
                    className="ghost xs"
                    disabled={busy}
                    onClick={() => void decide("reject", r)}
                  >
                    {t("chat.import.reject")}
                  </button>
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
      {errors.length > 0 && (
        <div className="chat-import-errors" role="alert">
          {errors.map((e) => (
            <div key={e.filename}>
              {e.filename}: {e.error}
            </div>
          ))}
        </div>
      )}
      {pending.length > 0 && (
        <div className="chat-import-actions">
          <label>
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />{" "}
            {t("chat.import.shared")}
          </label>
          <button
            type="button"
            className="sm"
            disabled={busy || !rows.some((r) => r.selected && r.status === "pending")}
            onClick={() => void decide("approve")}
          >
            {t("chat.import.approve")}
          </button>
        </div>
      )}
    </div>
  );
}
