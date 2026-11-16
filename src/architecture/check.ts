/**
 * Architecture fitness check: a small static import-graph analysis (no external dependency, no network).
 * It reports three kinds of violations and compares them to a committed baseline (architecture/baseline.json):
 *   - no-circular: strongly connected components of the src import graph with more than one file;
 *   - no-provider-from-core: src/workflow or src/eval importing the Claude module or a provider adapter;
 *   - no-provider-internals: a file outside src/agent/<provider>/ importing anything but that provider's entry files.
 * The baseline is a ratchet: a violation that is not in it fails the check; entries that no longer occur are reported
 * as stale so the baseline only shrinks (`npm run arch:baseline` rewrites it).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export type Rule = "no-circular" | "no-provider-from-core" | "no-provider-internals";
export interface Violation {
  rule: Rule;
  key: string;
  detail: string;
}
export interface Baseline {
  violations: string[];
}
export interface CheckResult {
  violations: Violation[];
  newViolations: Violation[];
  staleBaseline: string[];
  metrics: { files: number; edges: number; cycles: number; violations: number };
}

export type Graph = Map<string, string[]>;

export const PROVIDERS = ["codex", "cursor", "antigravity", "copilot"] as const;
/** Files a provider exposes to the rest of the code base; everything else under src/agent/<provider>/ is internal. */
export const PROVIDER_ENTRY_FILES = ["run.ts", "capabilities.ts", "index.ts"];
const CORE_PREFIXES = ["src/workflow/", "src/eval/"];

const IMPORT_RE = /(?:^|[\s;}])(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

export function listSourceFiles(root: string, dir = "src"): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(join(root, d)).sort()) {
      const rel = `${d}/${name}`;
      const st = statSync(join(root, rel));
      if (st.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(rel);
    }
  };
  walk(dir);
  return out;
}

export function parseImports(source: string): string[] {
  const specs: string[] = [];
  for (const m of source.matchAll(IMPORT_RE)) specs.push(m[1] ?? m[2]);
  return specs.filter((s) => s.startsWith("."));
}

/** Builds the relative-import graph. `read` and `exists` are injectable so tests need no file system. */
export function buildGraph(
  files: string[],
  read: (file: string) => string,
  exists: (file: string) => boolean,
): Graph {
  const fileSet = new Set(files);
  const graph: Graph = new Map();
  for (const file of files) {
    const deps = new Set<string>();
    for (const spec of parseImports(read(file))) {
      const target = join(dirname(file), spec).split(sep).join("/");
      const hit = [target, `${target}.ts`, `${target}/index.ts`].find((c) => fileSet.has(c) && exists(c));
      if (hit && hit !== file) deps.add(hit);
    }
    graph.set(file, [...deps].sort());
  }
  return graph;
}

/** Tarjan's algorithm; returns components with more than one file, each sorted, in a stable order. */
export function findCycles(graph: Graph): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const result: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) result.push(comp.sort());
    }
  };
  for (const v of [...graph.keys()].sort()) if (!idx.has(v)) visit(v);
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}

function providerOf(file: string): string | undefined {
  const m = /^src\/agent\/([^/]+)\//.exec(file);
  return m && (PROVIDERS as readonly string[]).includes(m[1]) ? m[1] : undefined;
}

export function findViolations(graph: Graph): Violation[] {
  const out: Violation[] = [];
  for (const comp of findCycles(graph)) {
    out.push({
      rule: "no-circular",
      key: `no-circular:${comp.join(",")}`,
      detail: `cycle of ${comp.length} files: ${comp.join(" <-> ")}`,
    });
  }
  for (const [from, deps] of graph) {
    for (const to of deps) {
      const toProvider = providerOf(to);
      const isClaudeModule = to === "src/agent/claude.ts";
      if (CORE_PREFIXES.some((p) => from.startsWith(p)) && (isClaudeModule || toProvider)) {
        out.push({
          rule: "no-provider-from-core",
          key: `no-provider-from-core:${from}->${to}`,
          detail: `${from} imports provider module ${to}`,
        });
      }
      if (toProvider && providerOf(from) !== toProvider && !PROVIDER_ENTRY_FILES.includes(to.split("/").pop()!)) {
        out.push({
          rule: "no-provider-internals",
          key: `no-provider-internals:${from}->${to}`,
          detail: `${from} imports internal file ${to} of provider ${toProvider}`,
        });
      }
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

const CYCLE_PREFIX = "no-circular:";

/**
 * A cycle is known when its files are all inside one baselined cycle, so removing a file from a baselined cycle never
 * reads as a new violation, while a cycle that pulls in a file outside the baseline does.
 */
export function compareToBaseline(violations: Violation[], baseline: Baseline): { newViolations: Violation[]; stale: string[] } {
  const known = new Set(baseline.violations);
  const baselineCycles = baseline.violations
    .filter((k) => k.startsWith(CYCLE_PREFIX))
    .map((k) => new Set(k.slice(CYCLE_PREFIX.length).split(",")));
  const current = new Set(violations.map((v) => v.key));
  const isKnown = (v: Violation) => {
    if (known.has(v.key)) return true;
    if (v.rule !== "no-circular") return false;
    const files = v.key.slice(CYCLE_PREFIX.length).split(",");
    return baselineCycles.some((c) => files.every((f) => c.has(f)));
  };
  return {
    newViolations: violations.filter((v) => !isKnown(v)),
    stale: baseline.violations.filter((k) => !current.has(k)),
  };
}

export function runCheck(root: string, baseline: Baseline): CheckResult {
  const files = listSourceFiles(root);
  const graph = buildGraph(files, (f) => readFileSync(join(root, f), "utf8"), (f) => existsSync(resolve(root, f)));
  const violations = findViolations(graph);
  const { newViolations, stale } = compareToBaseline(violations, baseline);
  return {
    violations,
    newViolations,
    staleBaseline: stale,
    metrics: {
      files: files.length,
      edges: [...graph.values()].reduce((n, d) => n + d.length, 0),
      cycles: violations.filter((v) => v.rule === "no-circular").length,
      violations: violations.length,
    },
  };
}

export function relativeTo(root: string, p: string): string {
  return relative(root, p).split(sep).join("/");
}
