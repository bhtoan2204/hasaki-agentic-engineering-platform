import { X } from "lucide-react";
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
      <div className="rv-card soft small si-ka-summary rv-inline-meta">
        <span>Snapshot #{snapshot.id}</span>
        <span className="mono">{snapshot.hash.slice(0, 16)}</span>
        <span>project {c.project || "none"}</span>
        <span>repos {c.repositories.join(", ") || "none"}</span>
        <span>{time(snapshot.created_at)}</span>
      </div>
      {!c.knowledge.length && <Empty>{t("si.noKnowledge")}</Empty>}
      {Object.entries(groups).map(([cat, items]) => (
        <div key={cat} className="rv-sec">
          <div className="rv-sec-title">
            {t(`kn.cat.${cat}`) === `kn.cat.${cat}` ? cat : t(`kn.cat.${cat}`)}
          </div>
          {items.map((k) => {
            const p = plan.get(k.key);
            return (
              <details key={k.key} className="rv-card si-ka-item">
                <summary>
                  <span className="rv-inline-meta">
                    <b>{k.title}</b>
                    <span className="mono muted">
                      {k.key} v{k.version}
                    </span>
                    <span className="muted small">{k.reason}</span>
                    {p && (
                      <Badge s={TIER[p.disclosure]}>
                        {p.disclosure} ({p.score})
                      </Badge>
                    )}
                  </span>
                  {p && <div className="muted small si-ka-why">{p.why}</div>}
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
        <div className="rv-sec">
          <div className="rv-sec-title">{t("si.upstream")}</div>
          {Object.entries(c.prompt_plan.upstream).map(([k, u]) => (
            <div key={k} className="small si-ka-upstream rv-inline-meta">
              <span>
                <b>{k}</b> {u.direct && <span className="muted">({t("si.direct")})</span>}
              </span>
              {u.mode === "full" ? (
                <span>{t("si.full")}</span>
              ) : (
                <span className="si-ka-summarised">{t("si.summarised")}</span>
              )}
              <span className="muted">
                ~{u.tokens} / {u.full_tokens} tokens
              </span>
            </div>
          ))}
        </div>
      )}
      {!!c.overridden?.length && (
        <div className="rv-sec">
          <div className="rv-sec-title">{t("si.overridden")}</div>
          {c.overridden.map((o) => (
            <div key={o.key} className="small muted">
              <X size={13} aria-hidden className="si-inline-icon err" />
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
        </div>
      )}
      {!!c.missing_explicit?.length && (
        <div className="errorbox small">
          {t("si.missing", { list: c.missing_explicit.join(", ") })}
        </div>
      )}
    </div>
  );
}
