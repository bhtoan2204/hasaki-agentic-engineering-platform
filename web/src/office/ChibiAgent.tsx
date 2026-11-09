import { memo, type SVGProps } from "react";
import { chibiPalette, chibiSprite, Prop, Px } from "./pixels.tsx";
import type { Activity, Pose, Role } from "./types.ts";
import { ROLES } from "./workflowToAgentMapper.ts";

/**
 * One chibi employee. Purely presentational: `pose`/`activity` come from workflowToAgentMapper, and all motion is CSS
 * keyed on data attributes (office.css), so animation logic stays separate from workflow-state mapping.
 */
export const ChibiAgent = memo(function ChibiAgent({
  role,
  pose,
  activity,
  x,
  y,
  walking,
  retrying,
  seated,
  hit,
}: {
  role: Role;
  pose: Pose;
  activity: Activity | null;
  x: number;
  y: number;
  walking: boolean;
  retrying?: boolean;
  seated?: boolean;
  hit?: SVGProps<SVGGElement>;
}) {
  const s = chibiSprite(role);
  const pal = chibiPalette(role);
  const mouth =
    pose === "celebrate"
      ? "open"
      : pose === "frustrated"
        ? "frown"
        : pose === "ask"
          ? "o"
          : pose === "work" || pose === "stopped" || pose === "skipped"
            ? "flat"
            : "smile";
  const act = pose === "work" ? (activity ?? "typing") : "none";
  return (
    <g
      {...hit}
      className={`chibi ${hit?.className ?? ""}`}
      data-pose={pose}
      data-act={act}
      data-walking={walking || undefined}
      data-retry={retrying || undefined}
      data-seated={seated || undefined}
      style={{
        transform: `translate(${x}px, ${y}px)`,
        ["--o-delay" as string]: `${ROLES.indexOf(role) * -1.17}s`,
      }}
    >
      <rect
        className="c-hit"
        x={0}
        y={-4}
        width={30}
        height={44}
        fill="transparent"
      />
      {!seated && (
        <ellipse className="c-shadow" cx={15} cy={39} rx={9} ry={1.6} />
      )}
      <g className="c-jump">
        <g className="c-legL">
          <Px rows={s.legL} pal={pal} />
        </g>
        <g className="c-legR">
          <Px rows={s.legR} pal={pal} />
        </g>
        <g className="c-torso">
          <Px rows={s.body} pal={pal} />
          <g className="c-armL">
            <Px rows={s.armL} pal={pal} />
          </g>
          <g className="c-armR">
            <Px rows={s.armR} pal={pal} />
          </g>
          <g className="c-head">
            <Px rows={s.head} pal={pal} />
            <g className="c-eyes">
              <Px
                rows={pose === "celebrate" ? s.happyEyes : s.eyes}
                pal={pal}
              />
            </g>
            <Px rows={s.mouth[mouth]} pal={pal} />
          </g>
          {/* hand-held props: chosen from the real activity, never decorative noise */}
          {pose === "idle" && (
            <Prop name="mug" x={0} y={27} className="p-mug" />
          )}
          {act === "reading" && (
            <Prop name="paper" x={11} y={25} className="p-paper" />
          )}
          {act === "writing" && (
            <Prop name="paper" x={11} y={25} className="p-paper" />
          )}
          {act === "knowledge" && (
            <Prop name="book" x={10} y={27} className="p-book" />
          )}
          {(act === "searching" || act === "reviewing") && (
            <Prop name="glass" x={16} y={23} className="p-glass" />
          )}
          {act === "packaging" && (
            <Prop name="box" x={10} y={27} className="p-box" />
          )}
          {act === "planning" && (
            <Prop name="clip" x={12} y={25} className="p-clip" />
          )}
          {pose === "approval" && (
            <Prop name="clip" x={12} y={25} className="p-clip" />
          )}
        </g>
      </g>
      {/* floating cues above the head */}
      {act === "thinking" && (
        <Prop name="bulb" x={23} y={-6} className="p-bulb" />
      )}
      {pose === "ask" && <Prop name="question" x={2} y={-8} className="p-q" />}
      {pose === "approval" && (
        <Prop name="check" x={23} y={-4} className="p-q" />
      )}
      {pose === "done" && (
        <Prop name="check" x={23} y={-2} className="p-check" />
      )}
      {pose === "frustrated" && (
        <Prop name="sweat" x={25} y={7} className="p-sweat" />
      )}
      {pose === "stopped" && (
        <Prop name="zzz" x={24} y={-1} className="p-zzz" />
      )}
      {act === "git" && (
        <Prop name="branch" x={24} y={-4} className="p-float" />
      )}
      {act === "submitting" && (
        <Prop name="plane" x={24} y={6} className="p-plane" />
      )}
      {act === "delegating" && (
        <Prop name="paper" x={25} y={14} className="p-plane" />
      )}
      {pose === "celebrate" && (
        <g className="p-confetti">
          {[
            ["#2f6b4f", 2, -2],
            ["#facc15", 9, -6],
            ["#22c55e", 18, -4],
            ["#3b82f6", 25, -1],
            ["#ec4899", 13, -9],
            ["#ffffff", 22, -8],
          ].map(([c, cx, cy], i) => (
            <rect
              key={i}
              x={cx as number}
              y={cy as number}
              width={2}
              height={2}
              fill={c as string}
              style={{ animationDelay: `${i * 0.12}s` }}
            />
          ))}
        </g>
      )}
      {retrying && pose === "work" && (
        <g className="p-determined">
          <rect x={-2} y={4} width={2} height={1} fill="#f97316" />
          <rect x={-3} y={7} width={3} height={1} fill="#f97316" />
          <rect x={-2} y={10} width={2} height={1} fill="#f97316" />
        </g>
      )}
    </g>
  );
});
