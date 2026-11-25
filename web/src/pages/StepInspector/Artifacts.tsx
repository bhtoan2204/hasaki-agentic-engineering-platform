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
          className="ghost rp-file"
          aria-expanded={openId === a.id}
          style={{
            width: "100%",
            justifyContent: "flex-start",
            whiteSpace: "normal",
            textAlign: "left",
            fontWeight: 400,
            ...(openId === a.id
              ? { borderColor: "var(--brand)", background: "var(--brand-50)" }
              : {}),
          }}
          onClick={() => setOpenId(openId === a.id ? null : a.id)}
        >
          <Paperclip size={14} color="var(--brand)" />
          <b className="grow" style={{ overflowWrap: "anywhere" }}>
            {a.name}
          </b>
          <span className="muted small">
            {a.kind} · {t("si.chars", { n: a.size })}
            {a.data?.exit_code != null && ` · ${t("si.exit", { code: a.data.exit_code })}`}
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
