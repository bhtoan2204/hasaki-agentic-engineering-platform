import { Px } from "./pixels.tsx";

/**
 * TEMPORARY Hasaki-style brand mark (no official logo asset is in this repository). Replace `HasakiMark` /
 * `HasakiWordmark` with the authorised asset when available — everything else references only these components.
 */
const MARK = [
  ".wwwwwww.",
  "wwrwwwrww",
  "wwrwwwrww",
  "wwrrrrrww",
  "wwrwwwrww",
  "wwrwwwrww",
  ".wwwwwww.",
];
export function HasakiMark({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`} aria-label="Hasaki (placeholder mark)">
      <Px rows={MARK} pal={{ w: "#ffffff", r: "#e2231a" }} />
    </g>
  );
}

/** Wall banner: red sign, white mark + "hasaki" lettering + office name. */
export function HasakiBanner({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x={1} y={15} width={86} height={2} fill="rgba(0,0,0,.18)" />
      <rect x={0} y={0} width={86} height={16} fill="#e2231a" />
      <rect x={0} y={0} width={86} height={1} fill="#ff5a4f" />
      <rect x={0} y={15} width={86} height={1} fill="#a50f14" />
      <HasakiMark x={4} y={4} />
      <text x={16} y={9.6} className="o-brand-text">hasaki</text>
      <text x={16} y={13.6} className="o-brand-sub">AI AGENT OFFICE</text>
      <rect x={-1} y={-3} width={1} height={4} fill="var(--o-trim)" />
      <rect x={86} y={-3} width={1} height={4} fill="var(--o-trim)" />
    </g>
  );
}
