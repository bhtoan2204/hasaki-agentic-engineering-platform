import { createHash } from "node:crypto";
export function cloneWindows(files: Record<string, string>, width = 30) {
  const seen = new Map<string, number>();
  for (const text of Object.values(files)) {
    const tokens = text.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\s\w]/g) ?? [];
    for (let i = 0; i + width <= tokens.length; i += width) {
      const hash = createHash("sha256")
        .update(tokens.slice(i, i + width).join(" "))
        .digest("hex");
      seen.set(hash, (seen.get(hash) ?? 0) + 1);
    }
  }
  return [...seen.values()].reduce((n, count) => n + Math.max(0, count - 1), 0);
}
export function changedCloneCount(before: Record<string, string>, after: Record<string, string>) {
  return Math.max(0, cloneWindows(after) - cloneWindows(before));
}
export function diffFootprint(numstat: string) {
  let added = 0,
    removed = 0,
    files = 0;
  for (const line of numstat.trim().split("\n")) {
    const [a, d] = line.split("\t");
    if (!/^\d+$/.test(a) || !/^\d+$/.test(d)) continue;
    added += Number(a);
    removed += Number(d);
    files++;
  }
  return { added, removed, files };
}
