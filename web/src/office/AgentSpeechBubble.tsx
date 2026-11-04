import type { AgentView } from "./types.ts";

/** Pixel-styled speech bubble pinned above a character (x/y are fractions of the stage). */
export function AgentSpeechBubble({ agent, x, y, emphasis }: { agent: AgentView; x: number; y: number; emphasis?: boolean }) {
  if (agent.pose === "skipped" || (agent.pose === "idle" && !agent.step)) return null;
  return (
    <div className={`o-bubble pose-${agent.pose}${emphasis ? " is-em" : ""}`} style={{ left: `${x * 100}%`, top: `${y * 100}%` }} aria-hidden>
      <span className="o-bubble-text">{agent.bubble}</span>
      {agent.activeCount > 1 && <span className="o-bubble-count">×{agent.activeCount}</span>}
    </div>
  );
}
