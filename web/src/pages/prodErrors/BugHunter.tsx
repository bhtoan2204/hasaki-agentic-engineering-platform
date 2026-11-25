import { useState } from "react";
import { Bug, ExternalLink } from "lucide-react";
import { useApi } from "../../api.ts";
import { Button, ErrorBox } from "../../ui.tsx";
import { useI18n } from "../../i18n/index.tsx";
import { dateCell, Panel, type Row } from "../analytics/shared.tsx";
import { ACTIVE_HUNT, HuntView, StartHuntForm, StatusPill, usePolling } from "./bugHuntParts.tsx";

/** Incident Detail page: every hunt of this incident (history), with the selected one in full. */
export function BugHunter({ fingerprint }: { fingerprint: string }) {
  const { t } = useI18n();
  const list = useApi<{ hunts: Row[] }>(`/api/prod-errors/${fingerprint}/bug-hunts`);
  const [selected, setSelected] = useState<number | null>(null);
  const [form, setForm] = useState(false);
  const hunts = list.data?.hunts ?? [];
  const current = selected ?? (hunts[0]?.id as number | undefined) ?? null;
  // The selected hunt polls itself (HuntView); the history list only polls for OTHER active hunts.
  usePolling(
    hunts.some((h) => ACTIVE_HUNT.has(h.status) && h.id !== current),
    list.reload,
  );
  return (
    <Panel title={t("an.bh.title")}>
      <div className="bh-intro">
        <p className="muted">{t("an.bh.intro")}</p>
        {!form && (
          <Button size="sm" icon={<Bug size={14} />} onClick={() => setForm(true)}>
            {t("an.bh.start")}
          </Button>
        )}
      </div>
      {form && (
        <StartHuntForm
          fingerprint={fingerprint}
          onStarted={(id) => (setSelected(id), setForm(false), list.reload())}
          onClose={() => setForm(false)}
        />
      )}
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      {!!hunts.length && (
        <ul className="bh-hunts" aria-label={t("an.bh.history")}>
          {hunts.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                className={h.id === current ? "active" : ""}
                aria-pressed={h.id === current}
                onClick={() => setSelected(h.id)}
              >
                <span>#{h.id}</span>
                <StatusPill status={h.status} />
                <span>{dateCell(h.created_at)}</span>
                <span className="muted">{(h.repositories as string[]).join(", ")}</span>
                {!ACTIVE_HUNT.has(h.status) && (
                  <span>
                    {t("an.bh.counts", {
                      c: h.counts.CONFIRMED,
                      s: h.counts.SUSPECTED,
                      r: h.counts.REJECTED,
                    })}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!hunts.length && !list.loading && <p className="muted">{t("an.bh.none")}</p>}
      {current != null && (
        <HuntView
          key={current}
          id={current}
          onChange={(s) => {
            // Keep the history row's status in step with the polled hunt.
            const row = hunts.find((h) => h.id === current);
            if (row && row.status !== s) list.reload();
          }}
        />
      )}
    </Panel>
  );
}

/**
 * The incident accordion (Incidents tab): the latest hunt (or the one the user started here) inline, a start form
 * when there is none, and a link to Incident Detail for the history and advanced investigation.
 */
export function BugHunterInline({
  fingerprint,
  huntId,
  onHunt,
  detailHref,
}: {
  fingerprint: string;
  /** The hunt to show (remembered by the list across collapse/refresh), or null when the incident has none. */
  huntId: number | null;
  /** A hunt was started here or its status changed: the list updates its row header. */
  onHunt: (huntId: number, status?: string) => void;
  detailHref: string;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState(false);
  return (
    <section className="bh-inline" aria-label={t("an.bh.title")}>
      <div className="bh-inline-head">
        <h4>
          <Bug size={15} aria-hidden="true" /> {t("an.bh.title")}
        </h4>
        <div className="bh-inline-actions">
          {!form && (
            <Button
              size="sm"
              variant="secondary"
              icon={<Bug size={14} />}
              onClick={() => setForm(true)}
            >
              {huntId ? t("an.bh.startAnother") : t("an.bh.start")}
            </Button>
          )}
          <a className="btn ghost sm" href={detailHref}>
            {t("an.bh.viewIncident")} <ExternalLink size={12} />
          </a>
        </div>
      </div>
      {!huntId && !form && <p className="muted small">{t("an.bh.introShort")}</p>}
      {form && (
        <StartHuntForm
          fingerprint={fingerprint}
          onStarted={(id) => (setForm(false), onHunt(id, "queued"))}
          onClose={() => setForm(false)}
        />
      )}
      {huntId != null && (
        <HuntView key={huntId} id={huntId} compact onChange={(s) => onHunt(huntId, s)} />
      )}
    </section>
  );
}
