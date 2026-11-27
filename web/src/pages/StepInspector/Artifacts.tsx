import { useState } from "react";
import { Paperclip } from "lucide-react";
import { useApi } from "../../api.ts";
import { Copy, Empty, JsonBlock, Markdown } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { type ArtifactContent, type ArtifactRow } from "./shared.tsx";

export function Artifacts({ artifacts }: { artifacts: ArtifactRow[] }) {
  const { t } = useI18n();
  const [openId, setOpenId] = useState<number | null>(null);
  const { data } = useApi<ArtifactContent>(openId ? `/api/artifacts/${openId}` : null, [openId]);
  if (!artifacts.length) return <Empty>{t("si.noArtifacts")}</Empty>;
  return (
    <div>
      {artifacts.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`ghost rp-file si-artifact-btn${openId === a.id ? " is-open" : ""}`}
          aria-expanded={openId === a.id}
          onClick={() => setOpenId(openId === a.id ? null : a.id)}
        >
          <Paperclip size={14} color="var(--brand)" />
          <b className="grow si-artifact-name">{a.name}</b>
          <span className="muted small rv-inline-meta">
            <span>{a.kind}</span>
            <span>{t("si.chars", { n: a.size })}</span>
            {a.data?.exit_code != null && <span>{t("si.exit", { code: a.data.exit_code })}</span>}
          </span>
        </button>
      ))}
      {openId && data && data.id === openId && (
        <div className="rv-card">
          <div className="rv-card-head">
            <h4>
              <Paperclip size={15} /> {data.name}
            </h4>
            <Copy text={data.content} />
          </div>
          {data.name.endsWith(".md") ? <Markdown text={data.content} /> : <pre>{data.content}</pre>}
          {data.data && <JsonBlock value={data.data} title={t("si.data")} />}
        </div>
      )}
    </div>
  );
}
