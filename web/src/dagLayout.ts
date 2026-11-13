/**
 * Layered left-to-right layout: one column per dependency depth, parallel steps stacked in their column.
 * A long graph folds into serpentine bands so the canvas width is used.
 */
const MAX_COLS = 5;
const DX = 260;
const DY = 168;
const SY = 104;

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
  const levels = [...layers.keys()].sort((a, b) => a - b).map((l) => layers.get(l)!);
  const bands = Math.max(1, Math.ceil(levels.length / MAX_COLS));
  const perBand = Math.max(1, Math.ceil(levels.length / bands));

  const pos: Record<string, { x: number; y: number }> = {};
  let bandTop = 0;
  for (let b = 0; b * perBand < levels.length; b++) {
    const band = levels.slice(b * perBand, (b + 1) * perBand);
    const tallest = Math.max(...band.map((keys) => keys.length));
    const mid = bandTop + ((tallest - 1) * SY) / 2;
    band.forEach((keys, slot) => {
      const x = (b % 2 === 0 ? slot : perBand - 1 - slot) * DX;
      // Order a column by its parents' height to keep edges from crossing.
      const anchor = (k: string) => {
        const ys = (byKey.get(k)?.depends_on ?? []).map((p) => pos[p]?.y).filter((y) => y != null);
        return ys.length ? ys.reduce((a, c) => a + c, 0) / ys.length : 0;
      };
      const ordered = keys
        .map((k, i) => ({ k, i, a: anchor(k) }))
        .sort((p, q) => p.a - q.a || p.i - q.i);
      ordered.forEach(({ k }, i) => {
        pos[k] = { x, y: mid + (i - (keys.length - 1) / 2) * SY };
      });
    });
    bandTop += (tallest - 1) * SY + DY;
  }
  return pos;
}

/** Side handles within a band; bottom to top where the band turns. */
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
