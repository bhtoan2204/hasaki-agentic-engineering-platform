import type { Route } from "./routes/types.ts";

/**
 * Narrows the route table before regex matching without changing which route wins. A request used to run every route's
 * regex in table order; now only the routes of its method whose first path segment equals the request's are tried, in
 * the same relative order. Routes whose pattern does not start with a literal `/api/<segment>` go to a wildcard bucket
 * that is merged back in table order, so the first match is always the one a full scan would have found.
 */
const FIRST_SEGMENT = /^\^\\\/api\\\/([a-z0-9-]+)(?:\\\/|\$)/;

interface Entry {
  order: number;
  route: Route;
}

export function buildRouteIndex(routes: readonly Route[]) {
  const buckets = new Map<string, Entry[]>();
  const add = (key: string, entry: Entry) => {
    const list = buckets.get(key);
    if (list) list.push(entry);
    else buckets.set(key, [entry]);
  };
  routes.forEach((route, order) => {
    const segment = FIRST_SEGMENT.exec(route[1].source)?.[1];
    add(`${route[0]} ${segment ?? "*"}`, { order, route });
  });

  const merge = (a: Entry[] = [], b: Entry[] = []) => {
    if (!b.length) return a;
    if (!a.length) return b;
    const out: Entry[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length)
      out.push(j >= b.length || (i < a.length && a[i].order < b[j].order) ? a[i++] : b[j++]);
    return out;
  };
  const cache = new Map<string, Route[]>();

  /** The routes that could match this method and path, in table order. */
  return function candidates(method: string, pathname: string): Route[] {
    const wildcard = `${method} *`;
    const segment = /^\/api\/([^/]+)/.exec(pathname)?.[1] ?? "";
    // Only keys that exist in the table are cached, so request-controlled segments and methods cannot grow the cache.
    const key = buckets.has(`${method} ${segment}`) ? `${method} ${segment}` : wildcard;
    let list = cache.get(key);
    if (!list) {
      list = (
        key === wildcard
          ? (buckets.get(wildcard) ?? [])
          : merge(buckets.get(key), buckets.get(wildcard))
      ).map((e) => e.route);
      cache.set(key, list);
    }
    return list;
  };
}
