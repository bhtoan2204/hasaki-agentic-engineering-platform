import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { uiLocale, useI18n } from "../i18n/index.tsx";

export interface Progress {
  phase: "connect" | "search" | "group" | "save" | "notify";
  pct: number;
  searchPct: number;
  splunkState?: string;
  scanned: number;
  matched: number;
  startedAt: string;
}

const STEP_KEYS: Array<{ key: Progress["phase"][]; label: string }> = [
  { key: ["connect"], label: "scan.connect" },
  { key: ["search"], label: "scan.search" },
  { key: ["group"], label: "scan.group" },
  { key: ["save", "notify"], label: "scan.save" },
];
const ORDER: Progress["phase"][] = ["connect", "search", "group", "save", "notify"];

const compact = (n: number) =>
  Intl.NumberFormat(uiLocale() === "vi" ? "vi-VN" : "en-GB", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const SPLUNK_KEY: Record<string, string> = {
  QUEUED: "scan.queued",
  PARSING: "scan.parsing",
  RUNNING: "scan.running",
  FINALIZING: "scan.finalizing",
  DONE: "scan.done",
};

/** A small original chibi bug-hunter (headband + magnifying glass), drawn inline so it themes with the page. */
function Chibi() {
  return (
    <svg className="chibi" viewBox="0 0 64 72" width="46" height="52" aria-hidden>
      <g className="chibi-body">
        {/* back arm */}
        <g className="chibi-arm-back">
          <rect x="20" y="40" width="6" height="14" rx="3" fill="var(--chibi-skin)" />
        </g>
        {/* legs */}
        <g className="chibi-leg-a">
          <rect x="24" y="52" width="7" height="13" rx="3.5" fill="var(--chibi-pants)" />
          <ellipse cx="28" cy="66" rx="5" ry="3" fill="var(--chibi-shoe)" />
        </g>
        <g className="chibi-leg-b">
          <rect x="33" y="52" width="7" height="13" rx="3.5" fill="var(--chibi-pants)" />
          <ellipse cx="37" cy="66" rx="5" ry="3" fill="var(--chibi-shoe)" />
        </g>
        {/* torso */}
        <rect x="21" y="37" width="22" height="19" rx="8" fill="var(--brand)" />
        <path
          d="M28 40 L32 46 L36 40"
          stroke="#fff"
          strokeWidth="1.6"
          fill="none"
          strokeLinecap="round"
          opacity=".8"
        />
        {/* head */}
        <circle cx="32" cy="22" r="17" fill="var(--chibi-skin)" />
        <path
          d="M15 19 Q16 4 32 4 Q48 4 49 19 Q44 11 32 11 Q20 11 15 19 Z"
          fill="var(--chibi-hair)"
        />
        <rect x="15" y="15" width="34" height="4.5" rx="2.2" fill="var(--st-err)" />
        <path d="M15.5 17 L8 13 L10 20 Z" fill="var(--st-err)" className="chibi-band" />
        {/* face */}
        <ellipse cx="26" cy="25" rx="2.3" ry="3" fill="#1d2420" />
        <ellipse cx="39" cy="25" rx="2.3" ry="3" fill="#1d2420" />
        <circle cx="26.8" cy="23.8" r=".9" fill="#fff" />
        <circle cx="39.8" cy="23.8" r=".9" fill="#fff" />
        <ellipse cx="22" cy="30" rx="3" ry="1.8" fill="#ff8fa3" opacity=".7" />
        <ellipse cx="43" cy="30" rx="3" ry="1.8" fill="#ff8fa3" opacity=".7" />
        <path
          d="M30 31 Q32.5 33.5 35 31"
          stroke="#1d2420"
          strokeWidth="1.4"
          fill="none"
          strokeLinecap="round"
        />
        {/* front arm + magnifying glass */}
        <g className="chibi-arm-front">
          <rect
            x="40"
            y="39"
            width="6"
            height="13"
            rx="3"
            fill="var(--chibi-skin)"
            transform="rotate(-50 43 41)"
          />
          <line
            x1="50"
            y1="38"
            x2="55"
            y2="33"
            stroke="#7a5a3a"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <circle
            cx="58.5"
            cy="29.5"
            r="5.2"
            fill="color-mix(in srgb, #9fd8ff 55%, transparent)"
            stroke="#5c6b73"
            strokeWidth="2"
          />
        </g>
      </g>
    </svg>
  );
}

export function ScanProgressCard({
  progress,
  typicalSeconds,
  startedAt,
}: {
  progress: Progress | null;
  typicalSeconds: number | null;
  startedAt?: string;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const p: Progress = progress ?? {
    phase: "connect",
    pct: 1,
    searchPct: 0,
    scanned: 0,
    matched: 0,
    startedAt: startedAt ?? new Date().toISOString(),
  };
  const elapsed = Math.max(0, (now - new Date(p.startedAt).getTime()) / 1000);
  const current = ORDER.indexOf(p.phase);
  const pct = Math.max(1, Math.min(100, p.pct));
  const remaining =
    typicalSeconds && elapsed < typicalSeconds ? Math.round(typicalSeconds - elapsed) : null;

  return (
    <div className="sp-card" role="status" aria-live="polite">
      <div className="sp-top">
        <div>
          <div className="sp-title">{t("scan.title")}</div>
          <div className="muted small">
            {p.phase === "search" ? (
              <>
                Splunk {t(SPLUNK_KEY[p.splunkState ?? ""] ?? "scan.running")} ·{" "}
                {t("scan.read", { n: compact(p.scanned) })}
                {p.matched ? <> · {t("scan.matched", { n: compact(p.matched) })}</> : null}
              </>
            ) : (
              t(STEP_KEYS.find((s) => s.key.includes(p.phase))?.label ?? "scan.connect")
            )}
          </div>
        </div>
        <div className="sp-pct">
          <b>{pct}%</b>
          <span className="muted small">
            {clock(elapsed)}
            {remaining != null
              ? ` · ${t("scan.left", { t: clock(remaining) })}`
              : typicalSeconds
                ? ` · ${t("scan.almost")}`
                : ""}
          </span>
        </div>
      </div>

      <div className="sp-track-wrap">
        <div className="sp-runner" style={{ left: `${pct}%` }}>
          <Chibi />
          <span className="sp-dust" />
        </div>
        <div className="sp-track">
          <div className="sp-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <ol className="sp-steps">
        {STEP_KEYS.map((s, i) => {
          const idx = Math.min(...s.key.map((k) => ORDER.indexOf(k)));
          const last = Math.max(...s.key.map((k) => ORDER.indexOf(k)));
          const state = current > last ? "done" : current >= idx ? "now" : "todo";
          return (
            <li key={i} className={`sp-step is-${state}`}>
              <span className="sp-dot">
                {state === "done" ? <Check size={12} strokeWidth={3} /> : i + 1}
              </span>
              <span>
                {t(s.label)}
                {s.key.includes("search") && state === "now" ? ` (${p.searchPct}%)` : ""}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
