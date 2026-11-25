import { useApi } from "../../api.ts";
import { Badge, Empty, ErrorBox, Markdown, SkeletonRows, time } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { type ContextSnapshot, type KnowledgeItem } from "./shared.tsx";

export function KnowledgeApplied({ snapshotId }: { snapshotId: number | null }) {
  const { t } = useI18n();
  const { data: snapshot, error } = useApi<ContextSnapshot>(
    snapshotId ? `/api/snapshots/${snapshotId}` : null,
    [snapshotId],
  );
  if (snapshotId && snapshot?.id !== snapshotId)
    return error ? <ErrorBox error={error} /> : <SkeletonRows rows={4} />;
  if (!snapshot) return <Empty>{t("si.noSnapshot")}</Empty>;
  const c = snapshot.content;
  const plan = new Map((c.prompt_plan?.knowledge ?? []).map((d) => [d.key, d] as const));
  const TIER: Record<string, string> = {
    inline: "COMPLETED",
    index: "READY",
    search: "PENDING",
  };
  const groups: Record<string, KnowledgeItem[]> = {};
  for (const k of c.knowledge) (groups[k.category] ??= []).push(k);
  return (
    <div>
      <div className="rv-card soft small" style={{ padding: "9px 12px" }}>
        Snapshot #{snapshot.id} · <span className="mono">{snapshot.hash.slice(0, 16)}</span> ·
        project {c.project || "—"} · repos {c.repositories.join(", ") || "—"} ·{" "}
        {time(snapshot.created_at)}
      </div>
      {!c.knowledge.length && <Empty>{t("si.noKnowledge")}</Empty>}
      {Object.entries(groups).map(([cat, items]) => (
        <div key={cat}>
          <h3>{t(`kn.cat.${cat}`) === `kn.cat.${cat}` ? cat : t(`kn.cat.${cat}`)}</h3>
          {items.map((k) => {
            const p = plan.get(k.key);
            return (
              <details
                key={k.key}
                className="rv-card"
                style={{ padding: "8px 12px", margin: "6px 0" }}
              >
                <summary style={{ color: "var(--ink)" }}>
                  <b>{k.title}</b>{" "}
                  <span className="mono muted">
                    {k.key} v{k.version}
                  </span>{" "}
                  <span className="muted small">· {k.reason}</span>{" "}
                  {p && (
                    <Badge s={TIER[p.disclosure]}>
                      {p.disclosure} · {p.score}
                    </Badge>
                  )}
                  {p && (
                    <div className="muted small" style={{ marginLeft: 16 }}>
                      {p.why}
                    </div>
                  )}
                </summary>
                <Markdown text={k.content} />
                <div className="row tight">
                  <a href={`#/knowledge/${k.key}`} className="small">
                    {t("si.openKnowledge")}
                  </a>
                </div>
              </details>
            );
          })}
        </div>
      ))}
      {c.prompt_plan?.upstream && Object.keys(c.prompt_plan.upstream).length > 0 && (
        <>
          <h3>{t("si.upstream")}</h3>
          {Object.entries(c.prompt_plan.upstream).map(([k, u]) => (
            <div key={k} className="small" style={{ padding: "2px 0" }}>
              <b>{k}</b> {u.direct && <span className="muted">({t("si.direct")})</span>} —{" "}
              {u.mode === "full" ? (
                t("si.full")
              ) : (
                <span style={{ color: "var(--st-wait)" }}>{t("si.summarised")}</span>
              )}{" "}
              ~{u.tokens} / {u.full_tokens} tokens
            </div>
          ))}
        </>
      )}
      {!!c.overridden?.length && (
        <>
          <h3>{t("si.overridden")}</h3>
          {c.overridden.map((o) => (
            <div key={o.key} className="small muted">
              ✗{" "}
              {o.reason === "superseded"
                ? t("si.supersededBy", {
                    key: o.key,
                    version: o.version,
                    by: o.by,
                  })
                : o.reason === "expired"
                  ? t("si.expiredRule", { key: o.key, version: o.version })
                  : t("si.overriddenBy", {
                      key: o.key,
                      version: o.version,
                      by: o.by,
                      conflict: o.conflict_key,
                    })}
            </div>
          ))}
        </>
      )}
      {!!c.missing_explicit?.length && (
        <div className="errorbox small">
          {t("si.missing", { list: c.missing_explicit.join(", ") })}
        </div>
      )}
    </div>
  );
}
