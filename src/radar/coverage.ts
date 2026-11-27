/**
 * Which hours a production error series was really observed at zero. An hour with no point in a series is "no events"
 * only where a scan that answered completely covered it: a scan that lost a source (partial), was cut (truncated),
 * skipped the group's source or was limited to other namespaces proves nothing about it. Pure.
 */
export interface CoveredScan {
  windowStart: Date;
  windowEnd: Date;
  /** The namespaces the scan was limited to; empty or null = all. */
  namespaces: string[] | null;
  partial: boolean;
  sources: Record<string, { status?: string; truncated?: boolean } | undefined> | null;
}

const HOUR = 3_600_000;

/** Start (epoch ms) of every complete hour of the scans that observed this group's source completely. */
export function coveredHours(
  group: { namespace: string; sources?: string[] },
  scans: CoveredScan[],
): number[] {
  const sources = group.sources?.length ? group.sources : ["splunk"];
  const hours = new Set<number>();
  for (const s of scans) {
    if (s.partial) continue;
    if (s.namespaces?.length && !s.namespaces.includes(group.namespace)) continue;
    const seen = sources.filter((name) => s.sources?.[name]?.status === "ok");
    if (!seen.length || seen.every((name) => s.sources?.[name]?.truncated)) continue;
    for (
      let h = Math.ceil(s.windowStart.getTime() / HOUR) * HOUR;
      h + HOUR <= s.windowEnd.getTime();
      h += HOUR
    )
      hours.add(h);
  }
  return [...hours].sort((a, b) => a - b);
}

/** The points of a series plus a zero for every covered hour it has no point at, oldest first. */
export function zeroFill(points: Array<{ at: Date; count: number }>, hours: number[]) {
  const seen = new Set(points.map((p) => p.at.getTime()));
  return [
    ...points,
    ...hours.filter((h) => !seen.has(h)).map((h) => ({ at: new Date(h), count: 0 })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
}
