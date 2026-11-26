import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildGraph,
  compareToBaseline,
  findCycles,
  findViolations,
  parseImports,
  runCheck,
  type Baseline,
  type Graph,
} from "../src/architecture/check.ts";

const graphOf = (src: Record<string, string>): Graph =>
  buildGraph(
    Object.keys(src),
    (f) => src[f],
    () => true,
  );

test("parseImports finds static, re-export, type and dynamic relative imports and excludes unrelated packages", () => {
  const specs = parseImports(
    [
      'import { a } from "./a.ts";',
      'import type { B } from "../b.ts";',
      'export * from "./c.ts";',
      'import "./side.ts";',
      'import x from "node:fs";',
      'const m = await import("./dyn.ts");',
    ].join("\n"),
  );
  assert.deepEqual(specs.sort(), ["../b.ts", "./a.ts", "./c.ts", "./dyn.ts", "./side.ts"]);
});

test("findCycles reports a two-file cycle and ignores acyclic edges", () => {
  const g = graphOf({
    "src/a.ts": 'import "./b.ts";',
    "src/b.ts": 'import "./a.ts";',
    "src/c.ts": 'import "./a.ts";',
  });
  assert.deepEqual(findCycles(g), [["src/a.ts", "src/b.ts"]]);
});

test("workflow importing the Claude module or a provider adapter is a core violation", () => {
  const g = graphOf({
    "src/workflow/x.ts": 'import "../agent/claude.ts"; import "../agent/codex/run.ts";',
    "src/agent/claude.ts": "",
    "src/agent/codex/run.ts": "",
  });
  const keys = findViolations(g).map((v) => v.key);
  assert.ok(keys.includes("no-provider-from-core:src/workflow/x.ts->src/agent/claude.ts"));
  assert.ok(keys.includes("no-provider-from-core:src/workflow/x.ts->src/agent/codex/run.ts"));
});

test("importing a provider internal file from outside is flagged, its entry file is not", () => {
  const g = graphOf({
    "src/agent/other.ts": 'import "./codex/policy.ts"; import "./codex/run.ts";',
    "src/agent/codex/policy.ts": "",
    "src/agent/codex/run.ts": 'import "./policy.ts";',
  });
  const v = findViolations(g);
  assert.deepEqual(
    v.map((x) => x.key),
    ["no-provider-internals:src/agent/other.ts->src/agent/codex/policy.ts"],
  );
});

test("a provider directory cannot import another provider, even its entry file", () => {
  const g = graphOf({
    "src/agent/cursor/run.ts": 'import "../codex/run.ts"; import "../broker/server.ts";',
    "src/agent/codex/run.ts": "",
    "src/agent/broker/server.ts": "",
  });
  assert.deepEqual(
    findViolations(g).map((x) => x.key),
    ["no-provider-cross-import:src/agent/cursor/run.ts->src/agent/codex/run.ts"],
  );
});

test("the agent lifecycle is reached only through the executor registry and never imports the engine", () => {
  const g = graphOf({
    "src/workflow/executors/index.ts": 'import "../../agent/harness/executor.ts";',
    "src/eval/runner.ts": 'import "../agent/harness/executor.ts";',
    "src/agent/harness/executor.ts": 'import "./lifecycle.ts"; import "../../workflow/types.ts";',
    "src/agent/harness/lifecycle.ts": "",
    "src/agent/harness/stages/verify.ts": 'import "../../../workflow/engine.ts";',
    "src/workflow/engine.ts": "",
    "src/workflow/types.ts": "",
  });
  assert.deepEqual(
    findViolations(g).map((x) => x.key),
    [
      "harness-no-workflow-core:src/agent/harness/stages/verify.ts->src/workflow/engine.ts",
      "harness-single-entry:src/eval/runner.ts->src/agent/harness/executor.ts",
    ],
  );
});

test("API handlers use repositories while the stream and analytics retain direct database access", () => {
  const graph = graphOf({
    "src/api/routes.ts": `import "../db/pool.ts"; import "../workitems/repository.ts"; import("pg");`,
    "src/api/stream.ts": `import "pg";`,
    "src/api/analytics/incidents.ts": `import "../../db/pool.ts";`,
    "src/db/pool.ts": "",
    "src/workitems/repository.ts": "",
  });
  assert.deepEqual(
    findViolations(graph).map((v) => v.key),
    ["no-db-from-api:src/api/routes.ts->pg", "no-db-from-api:src/api/routes.ts->src/db/pool.ts"],
  );
});

test("repositories can use infrastructure and shared types, while service and route imports are rejected", () => {
  const graph = graphOf({
    "src/workitems/repository.ts": `
      import "../db/pool.ts";
      import type { StepRow } from "../workflow/types.ts";
      import "../workflow/engine.ts";
      import "../api/routes.ts";
    `,
    "src/workflow/types.ts": "",
    "src/workflow/engine.ts": "",
    "src/api/routes.ts": "",
    "src/db/pool.ts": "",
  });
  assert.deepEqual(
    findViolations(graph).map((v) => v.key),
    [
      "repository-dependencies:src/workitems/repository.ts->src/api/routes.ts",
      "repository-dependencies:src/workitems/repository.ts->src/workflow/engine.ts",
    ],
  );
});

test("baseline ratchet rejects new violations and tolerates a shrunken baselined cycle", () => {
  const g = graphOf({
    "src/a.ts": 'import "./b.ts";',
    "src/b.ts": 'import "./a.ts";',
  });
  const violations = findViolations(g);
  assert.equal(compareToBaseline(violations, { violations: [] }).newViolations.length, 1);
  const bigger = { violations: ["no-circular:src/a.ts,src/b.ts,src/c.ts"] };
  assert.equal(compareToBaseline(violations, bigger).newViolations.length, 0);
  assert.deepEqual(compareToBaseline(violations, bigger).stale, [
    "no-circular:src/a.ts,src/b.ts,src/c.ts",
  ]);
});

test("the checked-in source tree has no violation outside architecture/baseline.json", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const baseline = JSON.parse(
    readFileSync(join(root, "architecture", "baseline.json"), "utf8"),
  ) as Baseline;
  const result = runCheck(root, baseline);
  assert.deepEqual(
    result.newViolations.map((v) => v.detail),
    [],
  );
});
