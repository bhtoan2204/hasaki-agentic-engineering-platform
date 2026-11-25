import { test } from "node:test";
import assert from "node:assert/strict";
import { routes, routesFor } from "../src/api/routes.ts";
import { buildRouteIndex } from "../src/api/routeIndex.ts";
import type { Route } from "../src/api/routes/types.ts";

const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"];

/** Every concrete value a capture group of the table can take, so a URL can be built from each pattern. */
const GROUPS: Record<string, string[]> = {
  "(\\d+)": ["12"],
  "([0-9a-f]{20})": ["0123456789abcdef0123"],
  "([a-z0-9_-]+)": ["step-1"],
  "([a-z0-9_.-]+)": ["skill.key-1"],
  "([A-Za-z0-9._-]+)": ["My.Repo-1"],
  "([\\w.-]+)": ["pay.svc"],
  "(?:bug-)?": ["", "bug-"],
};

function urlsFor(source: string): string[] {
  let variants = [source.replace(/^\^/, "").replace(/\$$/, "")];
  const expand = (match: string): string[] | undefined => {
    if (GROUPS[match]) return GROUPS[match];
    const alternatives = /^\(([\w|-]+)\)$/.exec(match)?.[1]?.split("|");
    return alternatives;
  };
  for (;;) {
    const next: string[] = [];
    let progressed = false;
    for (const v of variants) {
      const group = /\((?:\?:)?[^()]*\)\??/.exec(v);
      if (!group) {
        next.push(v);
        continue;
      }
      const values = expand(group[0]);
      assert.ok(values, `no sample for group ${group[0]} in ${source}`);
      progressed = true;
      for (const value of values) next.push(v.replace(group[0], value));
    }
    variants = next;
    if (!progressed) break;
  }
  return variants.map((v) => v.replace(/\\(.)/g, "$1"));
}

const samples = new Set<string>([
  "/",
  "/api",
  "/api/",
  "/api/nope",
  "/api/runs/abc",
  "/api/runs/12/unknown",
  "/health",
]);
for (const [, pattern] of routes)
  for (const url of urlsFor(pattern.source)) {
    samples.add(url);
    samples.add(url + "/");
    samples.add(url + "x");
    samples.add(url.replace(/\/[^/]*$/, ""));
  }

test("every route's own sample URL matches that route's pattern", () => {
  for (const [method, pattern] of routes)
    for (const url of urlsFor(pattern.source))
      assert.ok(pattern.test(url), `${method} ${pattern.source} did not match its sample ${url}`);
});

test("the indexed lookup picks the same route as a full scan for every method and sample URL", () => {
  const full = (method: string, url: string) =>
    routes.find(([m, p]) => m === method && p.test(url));
  const indexed = (method: string, url: string) =>
    routesFor(method, url).find(([, p]) => p.test(url));
  let checked = 0;
  let hits = 0;
  for (const method of METHODS)
    for (const url of samples) {
      const expected = full(method, url);
      assert.equal(indexed(method, url), expected, `${method} ${url}`);
      checked++;
      if (expected) hits++;
    }
  assert.ok(checked > 3000 && hits >= routes.length, `checked ${checked}, matched ${hits}`);
});

test("overlapping patterns keep their table order", () => {
  const winner = (method: string, url: string) =>
    routesFor(method, url).find(([, p]) => p.test(url));
  // GET /api/workflows/validate would also fit ([a-z0-9_-]+) but only POST is registered for validate.
  assert.equal(
    winner("POST", "/api/workflows/validate")?.[1].source,
    "^\\/api\\/workflows\\/validate$",
  );
  assert.equal(winner("POST", "/api/workflows/route")?.[1].source, "^\\/api\\/workflows\\/route$");
  assert.equal(winner("GET", "/api/runs/12")?.[1].source, "^\\/api\\/runs\\/(\\d+)$");
});

test("routes without a literal first segment still win in table order, and the cache stays bounded", () => {
  const handler = () => null;
  const table: Route[] = [
    ["GET", /^\/api\/(?:alpha|beta)\/x$/, handler],
    ["GET", /^\/api\/alpha\/x$/, handler],
    ["GET", /^\/api\/gamma$/, handler],
  ];
  const candidates = buildRouteIndex(table);
  assert.equal(candidates("GET", "/api/alpha/x")[0], table[0]);
  assert.deepEqual(candidates("GET", "/api/gamma"), [table[0], table[2]]);
  for (let i = 0; i < 1000; i++) candidates("GET", `/api/random-${i}/x`);
  assert.deepEqual(candidates("GET", "/api/random-1/x"), [table[0]]);
  assert.deepEqual(candidates("FOO", "/api/gamma"), []);
});
