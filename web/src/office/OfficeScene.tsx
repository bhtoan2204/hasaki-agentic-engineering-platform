import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChibiAgent } from "./ChibiAgent.tsx";
import { HasakiBanner } from "./brand.tsx";
import { Chair, CoffeeCorner, Desk, HelpDesk, Keyboard, Lamp, Monitor, Mug, PackTable, PaperStack, Plant, Room, screenMode, Whiteboard } from "./Furniture.tsx";
import { AgentSpeechBubble } from "./AgentSpeechBubble.tsx";
import { ROLE_INFO } from "./workflowToAgentMapper.ts";
import type { AgentView, Role } from "./types.ts";

export const STAGE_W = 320;
export const STAGE_H = 180;

/** Where each role works. Coordinates are stage pixels (1 unit = 1 art pixel). */
const STATIONS: Record<Role, { x: number; y: number; seated: boolean }> = {
  analyst: { x: 28, y: 44, seated: true },
  architect: { x: 130, y: 38, seated: false },
  developer: { x: 184, y: 44, seated: true },
  tester: { x: 40, y: 98, seated: true },
  reviewer: { x: 150, y: 98, seated: true },
  pr: { x: 232, y: 94, seated: false },
};
const HELP = { x: 250, y: 72 };
const WALK_MS = 1600;

function targets(agents: AgentView[]) {
  let slot = 0;
  const out = {} as Record<Role, { x: number; y: number; away: boolean }>;
  for (const a of agents) {
    const st = STATIONS[a.role];
    if (a.pose === "ask" || a.pose === "approval") out[a.role] = { x: HELP.x - 4 + (slot++ % 3) * 18, y: HELP.y - 16, away: true };
    else out[a.role] = { x: st.x, y: st.y, away: false };
  }
  return out;
}

/** Characters walk (legs animate) only while their position actually changes. */
function useWalking(pos: Record<Role, { x: number; y: number }>, still: boolean) {
  const prev = useRef<Record<string, string>>({});
  const [walking, setWalking] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const changed: string[] = [];
    for (const [role, p] of Object.entries(pos)) {
      const k = `${p.x},${p.y}`;
      if (prev.current[role] && prev.current[role] !== k) changed.push(role);
      prev.current[role] = k;
    }
    if (!changed.length || still) return;
    setWalking((w) => ({ ...w, ...Object.fromEntries(changed.map((r) => [r, true])) }));
    const t = setTimeout(() => setWalking((w) => ({ ...w, ...Object.fromEntries(changed.map((r) => [r, false])) })), WALK_MS);
    return () => clearTimeout(t);
  }, [pos, still]);
  return walking;
}

export function OfficeScene({
  agents, now, still, selected, onSelect, showBubbles = true,
}: { agents: AgentView[]; now: number; still: boolean; selected: Role | null; onSelect: (r: Role) => void; showBubbles?: boolean }) {
  const t = targets(agents);
  const key = JSON.stringify(t);
  const stablePos = useStable(t, key);
  const walking = useWalking(stablePos, still);
  const [hover, setHover] = useState<Role | null>(null);
  const by = Object.fromEntries(agents.map((a) => [a.role, a])) as Record<Role, AgentView>;
  const waiting = agents.filter((a) => a.pose === "ask" || a.pose === "approval").length;

  const agent = (role: Role) => {
    const a = by[role];
    const p = t[role];
    return (
      <ChibiAgent
        key={role}
        role={role}
        pose={a.pose}
        activity={a.activity}
        x={p.x}
        y={p.y}
        walking={!!walking[role]}
        retrying={a.retrying}
        seated={!p.away && STATIONS[role].seated && !walking[role]}
        hit={{
          role: "button",
          tabIndex: 0,
          "aria-label": a.detail,
          "aria-pressed": selected === role,
          className: `chibi-hit${selected === role ? " is-selected" : ""}`,
          onClick: () => onSelect(role),
          onKeyDown: (e: KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") (e.preventDefault(), onSelect(role));
          },
          onMouseEnter: () => setHover(role),
          onMouseLeave: () => setHover((h) => (h === role ? null : h)),
          onFocus: () => setHover(role),
          onBlur: () => setHover((h) => (h === role ? null : h)),
        } as any}
      />
    );
  };
  const mode = (r: Role) => screenMode(by[r].pose);
  const home = (r: Role) => !t[r].away;

  return (
    <div className="office-stage">
      <svg viewBox={`0 0 ${STAGE_W} ${STAGE_H}`} className="office-svg" shapeRendering="crispEdges" role="group" aria-label="Văn phòng AI Agent">
        <defs>
          <pattern id="o-planks" width="32" height="8" patternUnits="userSpaceOnUse">
            <rect width="32" height="8" fill="var(--o-floor)" />
            <rect y="7" width="32" height="1" fill="var(--o-floor-line)" />
            <rect x="12" width="1" height="8" fill="var(--o-floor-line)" />
            <rect x="2" y="2" width="6" height="1" fill="var(--o-floor-grain)" />
            <rect x="20" y="4" width="8" height="1" fill="var(--o-floor-grain)" />
          </pattern>
        </defs>
        <Room now={now} />
        <HasakiBanner x={150} y={6} />
        <Whiteboard x={82} y={16} mode={mode("architect")} />
        <HelpDesk x={HELP.x} y={HELP.y} waiting={waiting} />

        {/* back row */}
        <Chair x={32} y={64} />
        {agent("analyst")}
        <Desk x={16} y={73} w={58} />
        <PaperStack x={56} y={72} />
        <Lamp x={18} y={60} on={home("analyst") && by.analyst.pose === "work"} />
        <Mug x={48} y={69} steam={by.analyst.pose === "idle"} />

        {agent("architect")}

        <Chair x={188} y={64} />
        {agent("developer")}
        <Desk x={176} y={73} w={66} />
        <Keyboard x={190} y={72} />
        <Monitor x={216} y={53} mode={home("developer") ? mode("developer") : "saver"} kind="code" />
        <Mug x={180} y={69} steam={by.developer.pose === "idle"} />

        <CoffeeCorner x={102} y={104} />

        {/* front row */}
        <Chair x={44} y={118} />
        {agent("tester")}
        <Desk x={24} y={127} w={76} />
        <Keyboard x={46} y={126} />
        <Monitor x={70} y={105} w={26} h={18} mode={home("tester") ? mode("tester") : "saver"} kind="tests" />

        <Chair x={154} y={118} />
        {agent("reviewer")}
        <Desk x={128} y={127} w={80} />
        <Monitor x={130} y={109} w={20} h={14} mode={home("reviewer") ? mode("reviewer") : "saver"} kind="diff" />
        <Monitor x={184} y={109} w={22} h={14} mode={home("reviewer") ? mode("reviewer") : "saver"} kind="diff" />
        <Keyboard x={158} y={126} />

        {agent("pr")}
        <Desk x={226} y={124} w={56} />
        <PackTable x={226} y={124} mode={mode("pr")} />

        <Plant x={2} y={146} big />
        <Plant x={296} y={146} big />
      </svg>

      {showBubbles &&
        agents.map((a) => {
          const p = t[a.role];
          return (
            <AgentSpeechBubble key={a.role} agent={a} x={(p.x + 15) / STAGE_W} y={(p.y - (a.pose === "ask" || a.pose === "approval" ? 9 : 3)) / STAGE_H} emphasis={a.pose === "ask" || a.pose === "approval" || a.pose === "frustrated"} />
          );
        })}

      {hover && by[hover] && (
        <div className="office-hovercard" style={{ left: `${((t[hover].x + 15) / STAGE_W) * 100}%`, top: `${((t[hover].y + 41) / STAGE_H) * 100}%` }} role="tooltip">
          <b>{ROLE_INFO[hover].name}</b> <span className="muted">· {ROLE_INFO[hover].title}</span>
          <div>{by[hover].step ? <>Bước: <b>{by[hover].step!.name}</b> <span className="mono small">({by[hover].status})</span></> : <span className="muted">{ROLE_INFO[hover].does}</span>}</div>
          <div className="small">{by[hover].bubble}</div>
        </div>
      )}
    </div>
  );
}

/** Keep object identity while its serialised value is unchanged (so effects only fire on real moves). */
function useStable<T>(value: T, key: string): T {
  const ref = useRef<{ key: string; value: T }>({ key, value });
  if (ref.current.key !== key) ref.current = { key, value };
  return ref.current.value;
}
