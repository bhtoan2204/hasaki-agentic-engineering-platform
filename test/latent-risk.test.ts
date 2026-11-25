import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  LATENT_CASES,
  LATENT_DECOYS,
  latentFixtureFiles,
  scoreLatentFindings,
} from "../src/eval/latentBugFixtures.ts";
import {
  formatRisks,
  scanChanged,
  scanRef,
  scanSources,
  type GoSource,
} from "../src/latentRisk/scan.ts";

const sources = (files: Record<string, string>): GoSource[] =>
  Object.entries(files)
    .filter(([path]) => path.endsWith(".go"))
    .map(([path, source]) => ({ path, source }));

for (const c of LATENT_CASES) {
  test(`probe reports the seeded defect and not its fix: ${c.id}`, async () => {
    const risks = await scanSources(sources(c.buggy));
    assert.equal(risks.length, 1, JSON.stringify(risks));
    assert.equal(risks[0].rule, c.rule);
    assert.equal(risks[0].confidence, c.confidence);
    assert.equal(risks[0].symbol, c.symbol);
    assert.equal(risks[0].path, c.file);
    assert.match(risks[0].hint, /go test -race/);
    assert.deepEqual(await scanSources(sources(c.fixed)), [], "the fixed code is clean");
  });
}

for (const d of LATENT_DECOYS)
  test(`probe leaves correct look-alike code alone: ${d.id}`, async () => {
    assert.deepEqual(await scanSources(sources(d.files)), [], d.why);
  });

test("on the whole fixture module the probe has full recall and no false positive", async () => {
  const risks = await scanSources(sources(latentFixtureFiles()));
  assert.deepEqual(
    risks.map((r) => `${r.rule} ${r.symbol}`).sort(),
    LATENT_CASES.map((c) => `${c.rule} ${c.symbol}`).sort(),
  );
});

test("a diff scan sees the mutex of a struct the change did not touch", async () => {
  const [structFile, methodFile] = Object.entries(LATENT_CASES[3].buggy);
  const [risk] = await scanSources(
    [{ path: methodFile[0], source: methodFile[1] }],
    [{ path: structFile[0], source: structFile[1] }],
  );
  assert.equal(risk.symbol, "cache.Store.Entries");
  assert.deepEqual(
    await scanSources([{ path: methodFile[0], source: methodFile[1] }]),
    [],
    "without the struct there is nothing to prove, so nothing is reported",
  );
});

test("scoreLatentFindings counts a seeded defect when the file and symbol or line match", () => {
  const perfect = LATENT_CASES.map((c) => ({
    file: c.file,
    symbol: c.symbol,
    kind: "CONCURRENCY",
  }));
  assert.deepEqual(scoreLatentFindings(perfect), {
    recall: 1,
    matched: LATENT_CASES.map((c) => c.id),
    missed: [],
    extra: 0,
  });
  const none = scoreLatentFindings([{ file: "other.go", symbol: "x.y", kind: "CONCURRENCY" }]);
  assert.equal(none.recall, 0);
  assert.equal(none.extra, 1);
  const byLine = scoreLatentFindings([
    { file: "./events/events.go", line: 13, kind: "data_integrity" },
    { file: "events/events.go", symbol: "events.eventToFunc", kind: "PERFORMANCE" },
  ]);
  assert.deepEqual(byLine.matched, ["event-factory-shared-instance"], "line inside the function");
  assert.equal(byLine.extra, 1, "a wrong kind does not count");
});

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const sh = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", env: ENV }).trim();
function repoWith(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "latent-risk-"));
  sh(root, "init", "-q", "-b", "main");
  write(root, files);
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "base");
  return root;
}
function write(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

test("scanRef reads the committed Go source, skipping tests, mocks and vendored code", async () => {
  const bug = LATENT_CASES[0].buggy["events/events.go"];
  const root = repoWith({
    ...latentFixtureFiles(),
    "events/events_test.go": bug,
    "events/events_mock.go": bug,
    "vendor/x/x.go": bug,
  });
  const risks = await scanRef(root, "HEAD");
  assert.deepEqual(risks.map((r) => r.path).sort(), [
    "cache/accessors.go",
    "events/events.go",
    "registry/registry.go",
    "settings/snapshot.go",
  ]);
});

test("scanChanged reports only what the branch adds to its base", async () => {
  const [buggy, , registry] = [
    LATENT_CASES[0].buggy["events/events.go"],
    LATENT_CASES[1].buggy["settings/snapshot.go"],
    LATENT_CASES[2].buggy["registry/registry.go"],
  ];
  const root = repoWith({ "events/events.go": buggy, "go.mod": "module m\n\ngo 1.20\n" });
  sh(root, "checkout", "-qb", "feature");
  write(root, { "registry/registry.go": registry });
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "add registry");
  write(root, { "events/events.go": buggy + "\n// touched\n" });
  const risks = await scanChanged(root, "main");
  assert.deepEqual(
    risks.map((r) => r.symbol),
    ["registry.Registry.Items"],
    "the event factory was already in main: not attributed to this change",
  );
});

test("formatRisks lists candidates with the way to demonstrate each rule, and nothing when clean", async () => {
  assert.equal(formatRisks([{ repo: "svc", risks: [] }], "repository"), "");
  const risks = await scanSources(sources(latentFixtureFiles()));
  const text = formatRisks([{ repo: "svc", risks }], "repository");
  assert.match(text, /CANDIDATES, not findings/);
  assert.match(
    text,
    /\[high\/shared-instance-closure\] svc:events\/events\.go:\d+ \(events\.eventToFunc\)/,
  );
  assert.match(text, /- exposed-guarded-state: Test: read the returned value/);
  assert.match(formatRisks([{ repo: "svc", risks }], "diff"), /new candidates only/);
});

test("assessment and review steps carry the latent-risk sweep and the probe flag", async () => {
  const { TEMPLATES } = await import("../src/workflow/templates.ts");
  const steps = (key: string) =>
    (
      TEMPLATES.find((t) => t.key === key)!.spec.steps as Array<{
        key: string;
        config: { instructions?: string; latent_risks?: boolean; independent?: boolean };
      }>
    ).filter((s) => s.config);
  for (const key of ["codebase-assessment", "codebase-improvement"]) {
    const assess = steps(key).find((s) => s.key === "assess")!.config;
    assert.equal(assess.latent_risks, true, key);
    assert.match(String(assess.instructions), /Sweep for LATENT defects/);
    assert.match(String(assess.instructions), /closure|func\(\) T/);
  }
  const reviews = TEMPLATES.flatMap((t) => steps(t.key)).filter((s) =>
    /Review the diff of every workspace branch/.test(String(s.config.instructions)),
  );
  assert.ok(reviews.length >= 4, "every review built from REVIEW");
  for (const r of reviews) {
    assert.equal(r.config.latent_risks, true, r.key);
    assert.match(String(r.config.instructions), /Latent-defect rule \(Go\)/);
    assert.match(String(r.config.instructions), /reflect\.New\(typ\)\.Interface\(\)/);
  }
});

test("the CONCURRENCY recipe says how to demonstrate a shared instance and an escaped lock", async () => {
  const { KNOWLEDGE_SEEDS } = await import("../src/knowledge/service.ts");
  const seed = KNOWLEDGE_SEEDS.find((s) => s.key === "verification-recipes")!;
  assert.match(seed.content, /Shared instance \(a func\(\) T returning a captured pointer/);
  assert.match(seed.content, /distinct instances/);
  assert.match(seed.content, /returns a copy made while the lock is held/);
});

test("an untouched recipe seed is upgraded to the new text, an edited or other seed never", async () => {
  const { staleSeed } = await import("../src/knowledge/service.ts");
  const seed = { key: "verification-recipes", content: "new text" };
  const version = (o: { content?: string; change_note?: string; created_by?: string } = {}) => ({
    versions: [{ content: "old text", change_note: "seed", created_by: "", ...o }],
  });
  assert.equal(staleSeed(version(), seed), true);
  assert.equal(staleSeed(version({ change_note: "seed update" }), seed), true);
  assert.equal(staleSeed(version({ content: "new text" }), seed), false, "already current");
  assert.equal(staleSeed(version({ created_by: "alice" }), seed), false, "a person edited it");
  assert.equal(staleSeed(version({ change_note: "tighten the budget test" }), seed), false);
  assert.equal(staleSeed(version(), { ...seed, key: "unit-test-generation" }), false);
  assert.equal(staleSeed({ versions: [] }, seed), false);
});
