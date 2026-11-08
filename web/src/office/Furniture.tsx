import { useId, type CSSProperties } from "react";
import { HasakiMark } from "./brand.tsx";
import { useI18n } from "../i18n/index.tsx";
import type { Pose } from "./types.ts";

/** Pixel-art furniture for the office. Colours come from CSS variables (office.css) so day/night themes apply. */

const R = ({
  x,
  y,
  w,
  h,
  c,
  className,
  opacity,
  style,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  c?: string;
  className?: string;
  opacity?: number;
  style?: CSSProperties;
}) => (
  <rect
    x={x}
    y={y}
    width={w}
    height={h}
    fill={c}
    className={className}
    opacity={opacity}
    style={style}
  />
);

export type ScreenMode =
  | "off"
  | "saver"
  | "boot"
  | "work"
  | "ok"
  | "fail"
  | "wait";
export function screenMode(pose: Pose): ScreenMode {
  switch (pose) {
    case "work":
      return "work";
    case "celebrate":
    case "done":
      return "ok";
    case "frustrated":
      return "fail";
    case "ask":
    case "approval":
      return "wait";
    case "prepare":
      return "boot";
    case "idle":
      return "saver";
    default:
      return "off";
  }
}

function useClip() {
  return "clip" + useId().replace(/[^a-zA-Z0-9]/g, "");
}

// ------------------------------------------------------------------ room
export function Room({ now }: { now: number }) {
  const d = new Date(now);
  const hr = ((d.getHours() % 12) + d.getMinutes() / 60) * 30;
  const mn = d.getMinutes() * 6;
  return (
    <g>
      {/* wall + wainscot + floor */}
      <R x={0} y={0} w={320} h={74} c="var(--o-wall)" />
      {Array.from({ length: 40 }, (_, i) => (
        <R key={i} x={i * 8} y={0} w={1} h={52} c="var(--o-wall-line)" />
      ))}
      <R x={0} y={52} w={320} h={20} c="var(--o-wainscot)" />
      <R x={0} y={52} w={320} h={1} c="var(--o-trim)" />
      <R x={0} y={56} w={320} h={1} c="var(--o-hasaki-stripe)" />
      <R x={0} y={71} w={320} h={3} c="var(--o-trim)" />
      <R x={0} y={74} w={320} h={106} c="url(#o-planks)" />
      <R x={0} y={74} w={320} h={2} c="rgba(0,0,0,.12)" />
      {/* window */}
      <g>
        <R x={6} y={7} w={46} h={38} c="var(--o-trim)" />
        <R x={8} y={9} w={42} h={34} c="var(--o-sky)" className="o-sky" />
        <g className="o-day">
          <R x={38} y={13} w={6} h={6} c="#ffe27a" />
          <R x={14} y={16} w={12} h={3} c="#ffffff" opacity={0.85} />
          <R x={18} y={14} w={6} h={2} c="#ffffff" opacity={0.85} />
        </g>
        <g className="o-night">
          <R x={40} y={13} w={5} h={5} c="#f4f1d0" />
          <R x={42} y={13} w={3} h={3} c="var(--o-sky)" />
          {[
            [12, 14],
            [20, 20],
            [30, 12],
            [16, 28],
            [34, 24],
            [26, 30],
          ].map(([sx, sy], i) => (
            <R key={i} x={sx} y={sy} w={1} h={1} c="#fff" className="o-star" />
          ))}
        </g>
        {/* skyline */}
        {[
          [8, 30, 6, 13],
          [14, 26, 5, 17],
          [19, 33, 7, 10],
          [26, 28, 6, 15],
          [32, 31, 5, 12],
          [37, 24, 6, 19],
          [43, 32, 7, 11],
        ].map(([bx, by, bw, bh], i) => (
          <R key={i} x={bx} y={by} w={bw} h={bh} c="var(--o-skyline)" />
        ))}
        {[
          [16, 29],
          [28, 31],
          [39, 27],
          [39, 31],
          [21, 36],
        ].map(([wx, wy], i) => (
          <R key={i} x={wx} y={wy} w={1} h={1} c="var(--o-skyline-win)" />
        ))}
        <R x={28} y={9} w={2} h={34} c="var(--o-trim)" />
        <R x={8} y={25} w={42} h={2} c="var(--o-trim)" />
        <R x={4} y={45} w={50} h={3} c="var(--o-trim-dark)" />
      </g>
      {/* clock (real local time) */}
      <g transform="translate(66 12)">
        <circle cx={7} cy={7} r={7} fill="var(--o-trim)" />
        <circle cx={7} cy={7} r={5.6} fill="#fffaf2" />
        <line
          x1={7}
          y1={7}
          x2={7 + 3 * Math.sin((hr * Math.PI) / 180)}
          y2={7 - 3 * Math.cos((hr * Math.PI) / 180)}
          stroke="#2b1d1a"
          strokeWidth={1.1}
        />
        <line
          x1={7}
          y1={7}
          x2={7 + 4.6 * Math.sin((mn * Math.PI) / 180)}
          y2={7 - 4.6 * Math.cos((mn * Math.PI) / 180)}
          stroke="#2f6b4f"
          strokeWidth={0.7}
        />
        <R x={6.5} y={6.5} w={1} h={1} c="#2b1d1a" />
      </g>
      {/* rug for the human desk area */}
      <R x={244} y={86} w={74} h={16} c="var(--o-rug)" />
      <R x={246} y={88} w={70} h={12} c="var(--o-rug-in)" />
    </g>
  );
}

export function Plant({
  x,
  y,
  small,
  big,
}: {
  x: number;
  y: number;
  small?: boolean;
  big?: boolean;
}) {
  if (small)
    return (
      <g transform={`translate(${x} ${y})`}>
        <R x={2} y={5} w={5} h={4} c="#2f6b4f" />
        <g className="o-sway">
          <R x={1} y={2} w={2} h={3} c="#3f9b52" />
          <R x={4} y={0} w={2} h={5} c="#58b86a" />
          <R x={6} y={2} w={2} h={3} c="#3f9b52" />
        </g>
      </g>
    );
  const s = big ? 1.4 : 1;
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <g className="o-sway">
        <R x={5} y={0} w={3} h={8} c="#2f7d43" />
        <R x={1} y={4} w={5} h={3} c="#3f9b52" />
        <R x={8} y={3} w={5} h={3} c="#58b86a" />
        <R x={0} y={9} w={6} h={3} c="#58b86a" />
        <R x={8} y={9} w={6} h={3} c="#3f9b52" />
        <R x={3} y={12} w={8} h={3} c="#2f7d43" />
      </g>
      <R x={2} y={15} w={10} h={9} c="var(--o-pot)" />
      <R x={1} y={15} w={12} h={2} c="var(--o-pot-rim)" />
      <R x={2} y={23} w={10} h={1} c="rgba(0,0,0,.2)" />
    </g>
  );
}

// ------------------------------------------------------------------ desks
/** Desk top + front panel. Drawn after the seated character so it hides the legs. */
export function Desk({ x, y, w }: { x: number; y: number; w: number }) {
  return (
    <g>
      <R x={x} y={y} w={w} h={3} c="var(--o-wood-top)" />
      <R x={x} y={y + 3} w={w} h={1} c="var(--o-wood-dark)" />
      <R x={x + 1} y={y + 4} w={w - 2} h={14} c="var(--o-wood)" />
      <R x={x + 3} y={y + 7} w={w - 6} h={1} c="var(--o-wood-dark)" />
      <R x={x + 1} y={y + 17} w={w - 2} h={1} c="var(--o-wood-dark)" />
      <R x={x + 2} y={y + 18} w={2} h={4} c="var(--o-wood-dark)" />
      <R x={x + w - 4} y={y + 18} w={2} h={4} c="var(--o-wood-dark)" />
      <R x={x + 2} y={y + 22} w={w - 4} h={1} c="rgba(0,0,0,.18)" />
    </g>
  );
}

/** Chair back behind a seated character. */
export function Chair({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <R x={x} y={y} w={22} h={18} c="var(--o-chair)" />
      <R x={x + 2} y={y + 2} w={18} h={14} c="var(--o-chair-in)" />
      <R x={x} y={y} w={22} h={1} c="rgba(255,255,255,.25)" />
    </g>
  );
}

export function Keyboard({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <R x={x} y={y} w={16} h={3} c="#d7dae2" />
      {Array.from({ length: 7 }, (_, i) => (
        <R key={i} x={x + 1 + i * 2} y={y + 1} w={1} h={1} c="#9aa0ad" />
      ))}
    </g>
  );
}

export function Mug({
  x,
  y,
  steam,
}: {
  x: number;
  y: number;
  steam?: boolean;
}) {
  return (
    <g>
      {steam && (
        <g className="o-steam">
          <R x={x + 1} y={y - 3} w={1} h={2} c="var(--o-steam)" />
          <R x={x + 3} y={y - 4} w={1} h={2} c="var(--o-steam)" />
        </g>
      )}
      <R x={x} y={y} w={4} h={4} c="#fff7ef" />
      <R x={x + 1} y={y + 1} w={2} h={1} c="#2f6b4f" />
      <R x={x + 4} y={y + 1} w={1} h={2} c="#fff7ef" />
    </g>
  );
}

// ------------------------------------------------------------------ screens
export function Monitor({
  x,
  y,
  w = 24,
  h = 16,
  mode,
  kind,
}: {
  x: number;
  y: number;
  w?: number;
  h?: number;
  mode: ScreenMode;
  kind: "code" | "tests" | "diff";
}) {
  const id = useClip();
  const sx = x + 1,
    sy = y + 1,
    sw = w - 2,
    sh = h - 2;
  return (
    <g className="o-monitor" data-mode={mode}>
      <R x={x + w / 2 - 2} y={y + h} w={4} h={3} c="#4b5262" />
      <R x={x + w / 2 - 5} y={y + h + 3} w={10} h={1} c="#4b5262" />
      <R x={x - 1} y={y - 1} w={w + 2} h={h + 2} c="#262a35" />
      <R
        x={sx}
        y={sy}
        w={sw}
        h={sh}
        c={mode === "off" ? "#151821" : "var(--o-screen)"}
      />
      <clipPath id={id}>
        <rect x={sx} y={sy} width={sw} height={sh} />
      </clipPath>
      <g clipPath={`url(#${id})`}>
        {mode === "saver" && (
          <g className="s-saver">
            <HasakiMark x={sx + sw / 2 - 4.5} y={sy + sh / 2 - 3.5} />
          </g>
        )}
        {mode === "boot" && (
          <g className="s-boot">
            {[0, 1, 2].map((i) => (
              <R
                key={i}
                x={sx + 3 + i * 4}
                y={sy + sh / 2}
                w={2}
                h={2}
                c="#93c5fd"
              />
            ))}
          </g>
        )}
        {mode === "wait" && (
          <g className="s-blink">
            <R x={sx + sw / 2 - 1} y={sy + 3} w={2} h={sh - 8} c="#fbbf24" />
            <R x={sx + sw / 2 - 1} y={sy + sh - 4} w={2} h={2} c="#fbbf24" />
          </g>
        )}
        {mode === "ok" && (
          <g>
            <R x={sx} y={sy} w={sw} h={sh} c="#0f3d22" />
            {[
              [0, 4],
              [1, 5],
              [2, 6],
              [3, 5],
              [4, 4],
              [5, 3],
              [6, 2],
              [7, 1],
            ].map(([cx, cy], i) => (
              <R
                key={i}
                x={sx + sw / 2 - 4 + cx}
                y={sy + sh / 2 - 3 + cy}
                w={1.4}
                h={1.4}
                c="#4ade80"
              />
            ))}
          </g>
        )}
        {mode === "fail" && (
          <g className="s-blink">
            <R x={sx} y={sy} w={sw} h={sh} c="#3b0f12" />
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <g key={i}>
                <R
                  x={sx + sw / 2 - 3 + i}
                  y={sy + sh / 2 - 3 + i}
                  w={1.4}
                  h={1.4}
                  c="#f87171"
                />
                <R
                  x={sx + sw / 2 + 2 - i}
                  y={sy + sh / 2 - 3 + i}
                  w={1.4}
                  h={1.4}
                  c="#f87171"
                />
              </g>
            ))}
          </g>
        )}
        {mode === "work" && kind === "code" && (
          <g className="s-scroll">
            {CODE.concat(CODE).map(([ind, len, c], i) => (
              <R
                key={i}
                x={sx + 2 + ind * 2}
                y={sy + 2 + i * 2}
                w={len}
                h={1}
                c={c}
              />
            ))}
          </g>
        )}
        {mode === "work" && kind === "tests" && (
          <g>
            <R x={sx + 2} y={sy + 2} w={sw - 4} h={2} c="#1e293b" />
            <R
              x={sx + 2}
              y={sy + 2}
              w={sw - 4}
              h={2}
              c="#22c55e"
              className="s-progress"
            />
            {Array.from({ length: 12 }, (_, i) => (
              <R
                key={i}
                x={sx + 2 + (i % 6) * 3}
                y={sy + 6 + Math.floor(i / 6) * 3}
                w={2}
                h={2}
                c="#22c55e"
                className="s-dot"
                style={{ animationDelay: `${i * 0.18}s` }}
              />
            ))}
          </g>
        )}
        {mode === "work" && kind === "diff" && (
          <g>
            {DIFF.map(([c, len], i) => (
              <R key={i} x={sx + 1} y={sy + 1 + i * 2} w={len} h={1} c={c} />
            ))}
            <R
              x={sx}
              y={sy + 1}
              w={sw}
              h={2}
              c="rgba(250,204,21,.35)"
              className="s-scan"
            />
          </g>
        )}
      </g>
      <R x={sx} y={sy} w={sw} h={1} c="rgba(255,255,255,.08)" />
    </g>
  );
}
const CODE: Array<[number, number, string]> = [
  [0, 9, "#f472b6"],
  [1, 12, "#93c5fd"],
  [2, 7, "#fde68a"],
  [2, 10, "#86efac"],
  [1, 5, "#93c5fd"],
  [0, 3, "#f472b6"],
  [0, 8, "#c4b5fd"],
  [1, 11, "#86efac"],
  [2, 6, "#fde68a"],
  [1, 4, "#93c5fd"],
];
const DIFF: Array<[string, number]> = [
  ["#94a3b8", 14],
  ["#f87171", 10],
  ["#4ade80", 16],
  ["#4ade80", 9],
  ["#94a3b8", 12],
  ["#f87171", 7],
  ["#4ade80", 13],
];

// ------------------------------------------------------------------ role stations
export function Whiteboard({
  x,
  y,
  mode,
}: {
  x: number;
  y: number;
  mode: ScreenMode;
}) {
  return (
    <g className="o-board" data-mode={mode}>
      <R x={x} y={y} w={46} h={34} c="var(--o-trim-dark)" />
      <R x={x + 1} y={y + 1} w={44} h={32} c="#fbfbf8" />
      <R x={x + 4} y={y + 33} w={38} h={2} c="var(--o-trim-dark)" />
      <R x={x + 30} y={y + 32} w={4} h={1} c="#2f6b4f" />
      <R x={x + 35} y={y + 32} w={4} h={1} c="#2563eb" />
      <g className="b-diagram" fill="none" strokeWidth={0.8}>
        <rect
          x={x + 5}
          y={y + 5}
          width={10}
          height={6}
          stroke="#2563eb"
          className="b-line"
        />
        <rect
          x={x + 28}
          y={y + 5}
          width={12}
          height={6}
          stroke="#2f6b4f"
          className="b-line"
          style={{ animationDelay: ".6s" }}
        />
        <rect
          x={x + 16}
          y={y + 21}
          width={14}
          height={7}
          stroke="#16a34a"
          className="b-line"
          style={{ animationDelay: "1.2s" }}
        />
        <path
          d={`M${x + 15} ${y + 8} H${x + 28}`}
          stroke="#334155"
          className="b-line"
          style={{ animationDelay: "1.8s" }}
        />
        <path
          d={`M${x + 10} ${y + 11} V${y + 24} H${x + 16}`}
          stroke="#334155"
          className="b-line"
          style={{ animationDelay: "2.2s" }}
        />
        <path
          d={`M${x + 34} ${y + 11} V${y + 24} H${x + 30}`}
          stroke="#334155"
          className="b-line"
          style={{ animationDelay: "2.6s" }}
        />
      </g>
      {mode === "ok" && (
        <g>
          {[
            [0, 3],
            [1, 4],
            [2, 5],
            [3, 4],
            [4, 3],
            [5, 2],
            [6, 1],
          ].map(([cx, cy], i) => (
            <R
              key={i}
              x={x + 37 + cx}
              y={y + 20 + cy}
              w={1.2}
              h={1.2}
              c="#16a34a"
            />
          ))}
        </g>
      )}
      {mode === "fail" && (
        <g>
          {[0, 1, 2, 3, 4].map((i) => (
            <g key={i}>
              <R x={x + 37 + i} y={y + 20 + i} w={1.2} h={1.2} c="#dc2626" />
              <R x={x + 41 - i} y={y + 20 + i} w={1.2} h={1.2} c="#dc2626" />
            </g>
          ))}
        </g>
      )}
    </g>
  );
}

export function PaperStack({ x, y }: { x: number; y: number }) {
  return (
    <g>
      {[0, 1, 2, 3].map((i) => (
        <R
          key={i}
          x={x + (i % 2)}
          y={y - i * 2}
          w={10}
          h={2}
          c={i % 2 ? "#ffffff" : "#eceae4"}
        />
      ))}
      <R x={x + 2} y={y - 7} w={6} h={1} c="#2f6b4f" />
    </g>
  );
}

export function Lamp({ x, y, on }: { x: number; y: number; on: boolean }) {
  return (
    <g>
      {on && (
        <ellipse
          cx={x + 4}
          cy={y + 12}
          rx={9}
          ry={4}
          fill="var(--o-glow)"
          className="o-glow"
        />
      )}
      <R x={x + 3} y={y + 4} w={1} h={8} c="#3f4553" />
      <R x={x} y={y} w={8} h={4} c="#2f6b4f" />
      <R x={x + 1} y={y + 12} w={6} h={1} c="#3f4553" />
    </g>
  );
}

export function CoffeeCorner({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <R x={x} y={y + 14} w={22} h={22} c="var(--o-wood)" />
      <R x={x} y={y + 13} w={22} h={2} c="var(--o-wood-top)" />
      <R x={x + 3} y={y} w={12} h={13} c="#3d4250" />
      <R x={x + 5} y={y + 2} w={8} h={4} c="#1f2937" />
      <R x={x + 6} y={y + 3} w={2} h={1} c="#4ade80" />
      <R x={x + 7} y={y + 8} w={4} h={1} c="#9ca3af" />
      <Mug x={x + 7} y={y + 9} steam />
      <R x={x + 17} y={y + 9} w={3} h={4} c="#fde68a" />
    </g>
  );
}

export function PackTable({
  x,
  y,
  mode,
}: {
  x: number;
  y: number;
  mode: ScreenMode;
}) {
  return (
    <g className="o-pack" data-mode={mode}>
      {/* outbox tray with PR labels */}
      <R x={x + 38} y={y - 9} w={14} h={9} c="#cbd5e1" />
      <R x={x + 39} y={y - 8} w={12} h={7} c="#94a3b8" />
      <text x={x + 40} y={y - 2.6} className="o-tiny">
        PR
      </text>
      {mode === "ok" && <R x={x + 41} y={y - 12} w={8} h={3} c="#d9ad6d" />}
      {/* boxes next to the table */}
      <g transform={`translate(${x + 56} ${y + 2})`}>
        <R x={0} y={6} w={14} h={12} c="#d9ad6d" />
        <R x={0} y={6} w={14} h={2} c="#c99a5b" />
        <R x={5} y={9} w={4} h={2} c="#2f6b4f" />
        <R x={2} y={-4} w={10} h={10} c="#e0b87a" />
        <R x={2} y={-4} w={10} h={2} c="#c99a5b" />
      </g>
    </g>
  );
}

export function HelpDesk({
  x,
  y,
  waiting,
}: {
  x: number;
  y: number;
  waiting: number;
}) {
  const { t } = useI18n();
  return (
    <g className="o-help" data-waiting={waiting || undefined}>
      {/* wall sign */}
      <R
        x={x + 8}
        y={y - 52}
        w={48}
        h={16}
        c={waiting ? "#f59e0b" : "var(--o-trim-dark)"}
        className={waiting ? "o-sign-on" : undefined}
      />
      <R
        x={x + 9}
        y={y - 51}
        w={46}
        h={14}
        c={waiting ? "#fff7e0" : "var(--o-sign)"}
      />
      <text x={x + 32} y={y - 45.4} textAnchor="middle" className="o-sign-text">
        {t("office.sign")}
      </text>
      <text x={x + 32} y={y - 40} textAnchor="middle" className="o-sign-sub">
        {waiting
          ? t("office.waitingSign", { n: waiting })
          : t("office.nobodyWaiting")}
      </text>
      {/* counter */}
      <R x={x} y={y} w={66} h={4} c="var(--o-wood-top)" />
      <R x={x} y={y + 4} w={66} h={1} c="var(--o-wood-dark)" />
      <R x={x + 1} y={y + 5} w={64} h={14} c="#2f6b4f" />
      <R x={x + 1} y={y + 5} w={64} h={1} c="#4f9474" />
      <HasakiMark x={x + 28} y={y + 8} />
      {/* bell */}
      <R
        x={x + 52}
        y={y - 4}
        w={7}
        h={3}
        c="#f5c542"
        className={waiting ? "o-bell" : undefined}
      />
      <R x={x + 55} y={y - 5} w={1} h={1} c="#a16207" />
      <R x={x + 51} y={y - 1} w={9} h={1} c="#a16207" />
    </g>
  );
}

// ------------------------------------------------------------------ beauty retail
/** Small cosmetic products, pixel style. `kind` picks the silhouette. */
export function Product({
  x,
  y,
  kind,
  color,
}: {
  x: number;
  y: number;
  kind: "pump" | "serum" | "jar" | "lipstick" | "mask" | "tube" | "cushion";
  color: string;
}) {
  switch (kind) {
    case "pump":
      return (
        <g>
          <R x={x + 1} y={y} w={2} h={1} c="#3a3a48" />
          <R x={x + 1.5} y={y + 1} w={1} h={1} c="#3a3a48" />
          <R x={x} y={y + 2} w={4} h={6} c={color} />
          <R x={x} y={y + 4} w={4} h={2} c="#ffffff" opacity={0.8} />
        </g>
      );
    case "serum":
      return (
        <g>
          <R x={x + 1} y={y} w={1} h={2} c="#1f1f26" />
          <R x={x + 0.5} y={y + 2} w={2} h={1} c="#ffffff" />
          <R x={x} y={y + 3} w={3} h={5} c={color} />
          <R x={x} y={y + 3} w={1} h={5} c="#ffffff" opacity={0.35} />
        </g>
      );
    case "jar":
      return (
        <g>
          <R x={x} y={y + 4} w={5} h={1} c="#ffffff" />
          <R x={x} y={y + 5} w={5} h={3} c={color} />
          <R x={x + 1} y={y + 6} w={3} h={1} c="#ffffff" opacity={0.7} />
        </g>
      );
    case "lipstick":
      return (
        <g>
          <R x={x + 0.5} y={y + 2} w={1.5} h={2} c={color} />
          <R x={x + 0.5} y={y + 1.5} w={1} h={1} c={color} />
          <R x={x} y={y + 4} w={2.5} h={1} c="#d4af37" />
          <R x={x} y={y + 5} w={2.5} h={3} c="#1f1f26" />
        </g>
      );
    case "mask":
      return (
        <g>
          <R x={x} y={y + 1} w={6} h={7} c={color} />
          <R x={x + 1.5} y={y + 2.5} w={3} h={3} c="#ffffff" opacity={0.85} />
          <R x={x + 2} y={y + 3.3} w={0.6} h={0.6} c={color} />
          <R x={x + 3.4} y={y + 3.3} w={0.6} h={0.6} c={color} />
          <R x={x} y={y + 6.5} w={6} h={1} c="#ffffff" opacity={0.6} />
        </g>
      );
    case "tube":
      return (
        <g>
          <R x={x + 0.5} y={y} w={2} h={1} c="#ffffff" />
          <R x={x} y={y + 1} w={3} h={7} c={color} />
          <R x={x} y={y + 1} w={3} h={1} c="#ffffff" opacity={0.5} />
        </g>
      );
    case "cushion":
      return (
        <g>
          <R x={x} y={y + 5} w={5} h={3} c={color} />
          <R x={x} y={y + 5} w={5} h={1} c="#ffffff" opacity={0.6} />
        </g>
      );
  }
}

/** Wall display shelf: two tiers of skincare, serums, lipsticks and facial masks. */
export function BeautyShelf({ x, y }: { x: number; y: number }) {
  const row1: Array<[Parameters<typeof Product>[0]["kind"], string]> = [
    ["pump", "#f6c1c7"],
    ["serum", "#e8a33a"],
    ["serum", "#f08aa5"],
    ["jar", "#fbe3d3"],
    ["pump", "#cfe7d8"],
    ["tube", "#fdf1e7"],
    ["serum", "#c9a3e8"],
    ["jar", "#ffd1dc"],
  ];
  const row2: Array<[Parameters<typeof Product>[0]["kind"], string]> = [
    ["mask", "#ff9eb5"],
    ["mask", "#9ed8c3"],
    ["lipstick", "#c8102e"],
    ["lipstick", "#e85a7a"],
    ["lipstick", "#a4123f"],
    ["cushion", "#f3d1b8"],
    ["mask", "#ffd27a"],
    ["tube", "#2f6b4f"],
  ];
  return (
    <g>
      <R x={x - 1} y={y - 1} w={58} h={23} c="var(--o-shelf-back)" />
      {[0, 11].map((dy) => (
        <g key={dy}>
          <R x={x - 2} y={y + 9 + dy} w={60} h={2} c="var(--o-wood-top)" />
          <R x={x - 2} y={y + 11 + dy} w={60} h={1} c="var(--o-wood-dark)" />
        </g>
      ))}
      {row1.map(([k, c], i) => (
        <Product key={i} x={x + 1 + i * 7} y={y + 1} kind={k} color={c} />
      ))}
      {row2.map(([k, c], i) => (
        <Product key={i} x={x + 1 + i * 7} y={y + 12} kind={k} color={c} />
      ))}
      <g className="o-sparkle">
        <R x={x + 18} y={y + 2} w={1} h={1} c="#ffffff" />
        <R x={x + 44} y={y + 13} w={1} h={1} c="#ffffff" />
      </g>
    </g>
  );
}

/** Foreground "Beauty Bar" counter with testers — the office sits inside a Hasaki store. */
export function BeautyBar({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <R x={x} y={y} w={96} h={3} c="#fffaf3" />
      <R x={x} y={y + 3} w={96} h={1} c="#e7d6c7" />
      <R x={x + 1} y={y + 4} w={94} h={18} c="#2f6b4f" />
      <R x={x + 1} y={y + 4} w={94} h={1} c="#4f9474" />
      <R x={x + 4} y={y + 9} w={88} h={8} c="#1f4a36" opacity={0.35} />
      <text x={x + 48} y={y + 15} textAnchor="middle" className="o-bar-text">
        HASAKI BEAUTY BAR
      </text>
      {/* testers on mirrored trays */}
      <R x={x + 6} y={y - 1} w={26} h={1} c="#c9d6df" />
      <R x={x + 64} y={y - 1} w={26} h={1} c="#c9d6df" />
      <Product x={x + 7} y={y - 9} kind="pump" color="#f6c1c7" />
      <Product x={x + 13} y={y - 9} kind="serum" color="#e8a33a" />
      <Product x={x + 18} y={y - 9} kind="jar" color="#fbe3d3" />
      <Product x={x + 25} y={y - 9} kind="lipstick" color="#c8102e" />
      <Product x={x + 28} y={y - 9} kind="lipstick" color="#e85a7a" />
      <Product x={x + 65} y={y - 9} kind="mask" color="#ff9eb5" />
      <Product x={x + 72} y={y - 9} kind="mask" color="#9ed8c3" />
      <Product x={x + 79} y={y - 9} kind="tube" color="#fdf1e7" />
      <Product x={x + 84} y={y - 9} kind="cushion" color="#f3d1b8" />
      {/* round mirror */}
      <circle cx={x + 48} cy={y - 7} r={6} fill="#d4af37" />
      <circle cx={x + 48} cy={y - 7} r={4.8} fill="#e8f1f6" />
      <R x={x + 46} y={y - 10} w={2} h={1} c="#ffffff" />
      <R x={x + 47} y={y - 1} w={2} h={1} c="#d4af37" />
    </g>
  );
}

/** Warm pendant lamp hanging from the ceiling with a soft light cone (ambient). */
export function PendantLamp({ x, len = 8 }: { x: number; len?: number }) {
  return (
    <g>
      <polygon
        points={`${x - 3},${len + 4} ${x + 3},${len + 4} ${x + 16},${len + 46} ${x - 16},${len + 46}`}
        fill="var(--o-lamp-cone)"
        className="o-cone"
      />
      <R x={x - 0.25} y={0} w={0.5} h={len} c="#5b4636" />
      <R x={x - 3} y={len} w={6} h={3} c="#2f6b4f" />
      <R x={x - 2} y={len + 3} w={4} h={1} c="#ffe7a8" />
    </g>
  );
}

/** Handheld barcode scanner (packing station). */
export function Scanner({
  x,
  y,
  active,
}: {
  x: number;
  y: number;
  active: boolean;
}) {
  return (
    <g>
      <R x={x} y={y} w={6} h={3} c="#2f3340" />
      <R x={x + 1} y={y + 3} w={2} h={4} c="#2f3340" />
      <R
        x={x + 5}
        y={y + 1}
        w={1}
        h={1}
        c={active ? "#ff3b30" : "#7b1d1d"}
        className={active ? "o-scan-led" : undefined}
      />
      {active && (
        <R
          x={x + 6}
          y={y + 1.2}
          w={7}
          h={0.5}
          c="#ff3b30"
          opacity={0.75}
          className="o-scan-beam"
        />
      )}
    </g>
  );
}

/** Shipping box with Hasaki tape and a barcode label. */
export function ShippingBox({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <R x={x} y={y} w={14} h={10} c="#d9ad6d" />
      <R x={x} y={y} w={14} h={2} c="#c99a5b" />
      <R x={x + 6} y={y} w={2} h={10} c="#2f6b4f" />
      <R x={x + 9} y={y + 4} w={4} h={4} c="#ffffff" />
      {[0, 1, 2, 3].map((i) => (
        <R
          key={i}
          x={x + 9.4 + i * 0.9}
          y={y + 4.6}
          w={0.4}
          h={2.6}
          c="#1f1f26"
        />
      ))}
    </g>
  );
}

/** Wall sign with the official Hasaki logo on a white plate (logo never recoloured). */
export function LogoSign({
  x,
  y,
  href,
}: {
  x: number;
  y: number;
  href: string;
}) {
  return (
    <g>
      <R x={x + 1} y={y + 15} w={86} h={2} c="rgba(0,0,0,.18)" />
      <R x={x} y={y} w={86} h={16} c="#2f6b4f" />
      <R x={x} y={y} w={86} h={1} c="#4f9474" />
      <R x={x} y={y + 15} w={86} h={1} c="#183d2c" />
      <rect
        x={x + 2}
        y={y + 1.5}
        width={13}
        height={13}
        rx={2.5}
        fill="#ffffff"
      />
      <image
        href={href}
        x={x + 2}
        y={y + 1.5}
        width={13}
        height={13}
        preserveAspectRatio="xMidYMid meet"
        style={{ imageRendering: "auto" }}
      />
      <text x={x + 18} y={y + 8.6} className="o-brand-text">
        AI Workspace
      </text>
      <text x={x + 18} y={y + 12.8} className="o-brand-sub">
        ENGINEERING HEADQUARTERS
      </text>
      <R x={x - 1} y={y - 3} w={1} h={4} c="var(--o-trim)" />
      <R x={x + 86} y={y - 3} w={1} h={4} c="var(--o-trim)" />
    </g>
  );
}
