/** A long chain used to stack in one column. Fold it into a serpentine so the canvas width is used. */
const COLS = 4;
const DX = 260;
const DY = 168;

export interface LayoutStep {
  key: string;
  depends_on?: string[];
}

export function autoLayout(steps: LayoutStep[]): Record<string, { x: number; y: number }> {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const depth = new Map<string, number>();
  const d = (k: string, seen = new Set<string>()): number => {
    if (depth.has(k)) return depth.get(k)!;
    if (seen.has(k)) return 0;
    seen.add(k);
    const deps = byKey.get(k)?.depends_on ?? [];
    const v = deps.length ? Math.max(...deps.map((x) => d(x, seen) + 1)) : 0;
    depth.set(k, v);
    return v;
  };
  steps.forEach((s) => d(s.key));
  const layers = new Map<number, string[]>();
  for (const s of steps) {
    const level = depth.get(s.key)!;
    (layers.get(level) ?? layers.set(level, []).get(level)!).push(s.key);
  }
  const pos: Record<string, { x: number; y: number }> = {};
  let row = 0;
  let col = 0;
  let dir: 1 | -1 = 1;
  const xOf = (slot: number) => (dir === 1 ? slot : COLS - 1 - slot) * DX;
  const wrap = () => {
    row += 1;
    dir = dir === 1 ? -1 : 1;
    col = 0;
  };
  for (const level of [...layers.keys()].sort((a, b) => a - b)) {
    const keys = layers.get(level)!;
    if (keys.length === 1) {
      if (col >= COLS) wrap();
      pos[keys[0]] = { x: xOf(col), y: row * DY };
      col += 1;
      continue;
    }
    if (col !== 0) {
      row += 1;
      col = 0;
      dir = 1;
    }
    const origin = keys.length <= COLS ? Math.floor((COLS - keys.length) / 2) : 0;
    keys.forEach((k, i) => (pos[k] = { x: (origin + i) * DX, y: row * DY }));
    row += 1;
    col = 0;
    dir = 1;
  }
  return pos;
}

/** Side handles along a row; top and bottom at a turn. */
export function edgeEnds(
  src: { x: number; y: number },
  dst: { x: number; y: number },
): { sourceHandle?: string; targetHandle?: string } {
  const dx = dst.x - src.x;
  const dy = dst.y - src.y;
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8)
    return dx > 0
      ? { sourceHandle: "sr", targetHandle: "tl" }
      : { sourceHandle: "sl", targetHandle: "tr" };
  return {};
}
