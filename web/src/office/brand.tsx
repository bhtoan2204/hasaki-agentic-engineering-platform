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
export function HasakiMark({
  x,
  y,
  scale = 1,
}: {
  x: number;
  y: number;
  scale?: number;
}) {
  return (
    <g
      transform={`translate(${x} ${y}) scale(${scale})`}
      aria-label="Hasaki (placeholder mark)"
    >
      <Px rows={MARK} pal={{ w: "#ffffff", r: "#2f6b4f" }} />
    </g>
  );
}
