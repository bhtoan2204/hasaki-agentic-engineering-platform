import { Layers, Wrench, X } from "lucide-react";
import { Badge } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { type BaselineGroup, type CommandBaseline, type CommandResult } from "./shared.tsx";

/** Branch-vs-base classification of Go test failures for each repo of a command step. */
export function BaselineSummary({ results }: { results?: CommandResult[] }) {
  const { t } = useI18n();
  const withBase = (results ?? []).filter(
    (r): r is CommandResult & { baseline: CommandBaseline } => !!r.baseline,
  );
  if (!withBase.length) return null;
  const Item = ({ x }: { x: Required<BaselineGroup> }) => (
    <div className="small" style={{ margin: "2px 0 6px 12px" }}>
      <span className="mono" style={{ fontWeight: 600 }}>
        {x.package}
      </span>
      {x.tests.map((t: string) => (
        <div key={t} className="mono" style={{ marginLeft: 12 }}>
          <X size={10} style={{ verticalAlign: -1 }} /> {t}
        </div>
      ))}
      {x.build_errors.map((e: string) => (
        <div key={e} className="mono" style={{ marginLeft: 12 }}>
          <Wrench size={10} style={{ verticalAlign: -1 }} /> {e}
        </div>
      ))}
    </div>
  );
  return (
    <div className="rv-card">
      <div className="rv-card-head">
        <h4>
          <Layers size={16} /> {t("si.vsBaseline")}
        </h4>
      </div>
      {withBase.map((r) => (
        <div key={r.repo} className="vf-repo">
          <div className="vf-repo-head">
            <b className="grow">{r.repo}</b>
            {r.baseline.regressions &&
              (r.baseline.regressions.length ? (
                <Badge s="FAILED">
                  {t("si.regressions", { n: r.baseline.regressions.length })}
                </Badge>
              ) : (
                <Badge s="COMPLETED">{t("si.noRegression")}</Badge>
              ))}
          </div>
          {r.baseline.note ? (
            <div className="muted small">{r.baseline.note}</div>
          ) : (
            <div className="muted small mono">base {String(r.baseline.base_sha).slice(0, 9)}</div>
          )}
          {!!r.baseline.regressions?.length && (
            <div className="err small" style={{ marginTop: 6, fontWeight: 600 }}>
              {t("si.newFaults")}
            </div>
          )}
          {r.baseline.regressions?.map((x) => (
            <Item key={x.package} x={x} />
          ))}
          {!!r.baseline.pre_existing?.length && (
            <div className="muted small" style={{ marginTop: 6 }}>
              {t("si.oldFaults")}
            </div>
          )}
          {r.baseline.pre_existing?.map((x) => (
            <Item key={"p" + x.package} x={x} />
          ))}
        </div>
      ))}
    </div>
  );
}
