/** Map bookmarked health URLs without changing their applied query. */
export function legacyProductionRoute(path: string, query = ""): string | null {
  if (path !== "/insights/health") return null;
  const service = new URLSearchParams(query).get("view") === "service";
  return `/prod-errors/${service ? "service" : "overview"}${query ? `?${query}` : ""}`;
}

/** Only known, local production destinations can be used as return links. */
export function trustedProductionReturn(value: string | null): string {
  if (!value || /[\\\r\n#]/.test(value)) return "/prod-errors/incidents";
  const [path, ...query] = value.split("?");
  const legacy = legacyProductionRoute(path, query.join("?"));
  if (legacy) return legacy;
  return /^\/prod-errors(?:\/(?:overview|incidents|services|service|settings))?$/.test(
    path,
  )
    ? value
    : "/prod-errors/incidents";
}
