/**
 * CODE_SEARCH_ENGINE=go (ADR 0006). First the whole code intelligence suite (code-intelligence.integration.ts) runs
 * with searches answered by a real platform-go: stale overlays, modified/deleted/renamed files, symlinks,
 * unauthorized repositories and traversal, ranking ties, proto dependencies. Then both engines answer the same
 * queries on the same repositories, snapshots and worktrees and must agree hit for hit; plus the internal API's own
 * defenses, secret redaction, fallback, timeout and cancellation. Fails without a Go toolchain.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { config } from "../src/config.ts";
import { goToolchain, requireGoToolchain, startPlatformGo } from "./fixtures/platformGo.ts";

if (!goToolchain()) {
  requireGoToolchain("code search with the Go engine");
} else {
  const go = await startPlatformGo();
  after(go.stop);
  config.codeIntelligence.searchEngine = "go";
  await import("./code-intelligence.integration.ts");
  const search = await import("../src/codeIntelligence/search.ts");
  const { goSearchStats } = await import("../src/codeIntelligence/goSearch.ts");
  const { repositories } = await import("../src/repos/service.ts");
  const { indexRepository } = await import("../src/codeIntelligence/indexer.ts");
  const { retrievalService } = await import("../src/retrieval/semantic.ts");
  const { parserVersion } = await import("../src/codeIntelligence/parser.ts");
  const { startRun } = await import("../src/workflow/engine.ts");
  const { recordWorkspace } = await import("../src/git/provider.ts");

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const git = (root: string, ...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env }).trim();
  const fixtures = resolve(import.meta.dirname, "../src/codeIntelligence");
  const repos = ["cs-alpha", "cs-beta", "cs-gamma"];
  const roots: Record<string, string> = {};
  let run: { id: number };
  // Registered after the imported suite's before(): migrations, the ci-fixture definition, sharing.
  before(async () => {
    for (const [i, name] of repos.entries()) {
      const root = join(config.reposRoot, name);
      mkdirSync(root, { recursive: true });
      cpSync(fixtures, join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", `extra${i}.ts`),
        `export function sharedHelper${i}() { return "password=hunter2-secret-value"; }\nexport const searchSymbols = 1;\n`,
      );
      git(root, "init", "-q", "-b", config.baseBranch);
      git(root, "add", ".");
      git(root, "commit", "-qm", "base");
      await repositories.upsert(name, { projects: ["CS"] });
      await indexRepository(name);
      roots[name] = root;
    }
    // A run with a worktree of cs-beta: modified, deleted, renamed and added files, indexed as an overlay.
    run = await startRun({
      definitionKey: "ci-fixture",
      title: "CS",
      repositories: ["cs-beta"],
      inputs: { project: "CS" },
      start: false,
    });
    const wt = join(config.dataDir, "cs-beta-wt");
    git(roots["cs-beta"], "worktree", "add", "-qb", "cs-wt", wt);
    await recordWorkspace(run.id, {
      repo: "cs-beta",
      path: wt,
      branch: "cs-wt",
      created_from: "base",
    });
    writeFileSync(
      join(wt, "src", "search.ts"),
      readFileSync(join(wt, "src", "search.ts"), "utf8") + "\nexport function overlayOnly() {}\n",
    );
    execFileSync("rm", [join(wt, "src", "store.ts")]);
    git(wt, "mv", "src/git.ts", "src/gitRenamed.ts");
    writeFileSync(join(wt, "src", "added.ts"), "export function addedInWorktree() { return 1 }\n");
    await indexRepository("cs-beta", run.id);
  });

  const scope = (extra: Record<string, unknown> = {}) => ({
    repositories: repos,
    allowed: repos,
    provision: false,
    ...extra,
  });
  const runScope = () => scope({ runId: run.id });
  const strip = (x: unknown): unknown =>
    JSON.parse(
      JSON.stringify(x, (k, v) =>
        k === "search_latency" || k === "context_latency" ? undefined : v,
      ),
    );
  const both = async <T>(fn: () => Promise<T>) => {
    config.codeIntelligence.searchEngine = "typescript";
    const ts = await fn();
    config.codeIntelligence.searchEngine = "go";
    const calls = goSearchStats.calls;
    const viaGo = await fn();
    assert.ok(goSearchStats.calls > calls, "answered by platform-go");
    return { ts: strip(ts), go: strip(viaGo) };
  };

  const queries = [
    "searchSymbols fresh",
    "buildCodeContext applyEvidence",
    "eligibleText queryTerms",
    "overlayOnly addedInWorktree readSource",
    "sharedHelper0 sharedHelper2",
    "noSuchSymbolAnywhereXyz",
    "search.ts",
  ];
  for (const [label, sc] of [
    ["base snapshots", scope],
    ["a run worktree overlay", runScope],
  ] as const)
    test(`parity: symbols, definitions, dependencies, references and code context (${label})`, async () => {
      for (const q of queries) {
        const r = await both(() => search.searchSymbols(q, sc(), 30));
        assert.deepEqual(r.go, r.ts, `searchSymbols ${q}`);
      }
      for (const sym of ["searchSymbols", "fresh", "localScope", "applyEvidence"]) {
        let r = await both(() => search.findDefinitions(sym, sc()));
        assert.deepEqual(r.go, r.ts, `findDefinitions ${sym}`);
        r = await both(() => search.findDependencies(sym, sc(), 2));
        assert.deepEqual(r.go, r.ts, `findDependencies ${sym}`);
        r = await both(() => search.findReferences(sym, sc()));
        assert.deepEqual(r.go, r.ts, `findReferences ${sym}`);
      }
      for (const q of queries.slice(0, 5)) {
        const r = await both(() => search.buildCodeContext(q, sc()));
        assert.deepEqual(r.go, r.ts, `buildCodeContext ${q}`);
      }
      const rows = (await repositories.list()).filter((r) => repos.includes(r.name));
      const hybrid = await both(() =>
        search.hybridRank(rows, { text: "searchSymbols readSource" }),
      );
      assert.deepEqual(hybrid.go, hybrid.ts, "hybridRank");
    });

  test("parity: exact search keeps the repository order and the limit across repositories", async () => {
    for (const [pattern, limit, anyFile] of [
      ["searchSymbols", 7, false],
      ["export function", 20, false],
      ["hunter2", 5, true],
    ] as const) {
      const r = await both(() => search.searchCodeExact(pattern, scope(), limit, { anyFile }));
      const go = r.go as Array<{ repository: string; file_path: string }>;
      const ts = r.ts as typeof go;
      assert.equal(go.length, ts.length, pattern);
      // ripgrep walks in parallel for TypeScript; Go asks it for path order. The per-repository sets agree, and
      // repositories appear in scope order in both.
      const order = (h: typeof go) => [...new Set(h.map((x) => x.repository))];
      assert.deepEqual(order(go), order(ts));
      if (go.length < limit)
        assert.deepEqual(
          new Set(go.map((h) => JSON.stringify(h))),
          new Set(ts.map((h) => JSON.stringify(h))),
        );
    }
  });

  test("secrets in snippets are redacted by Go as by TypeScript", async () => {
    config.codeIntelligence.searchEngine = "go";
    const hits = await search.searchCodeExact("hunter2", scope(), 5, { anyFile: true });
    assert.ok(hits.length > 0);
    for (const h of hits) assert.doesNotMatch(h.snippet!, /hunter2/);
    const ctx = await search.buildCodeContext("sharedHelper1", scope());
    assert.doesNotMatch(ctx.body, /hunter2/);
  });

  test("a revoked repository permission is resolved by TypeScript and never reaches Go", async () => {
    config.codeIntelligence.searchEngine = "go";
    await repositories.upsert("cs-gamma", { projects: ["CS"], allowed_actions: [] } as never);
    try {
      const r = await search.searchSymbols("sharedHelper2", scope(), 30);
      assert.ok(
        !r.hits.some((h) => h.repository === "cs-gamma"),
        "no evidence from the revoked repository",
      );
      assert.ok(r.fallback_count >= 1);
      const report = { unavailable: [] as string[] };
      await search.findDependencies("searchSymbols", scope(), 1, "out", report);
      assert.ok(report.unavailable.some((u) => u.startsWith("cs-gamma")));
    } finally {
      await repositories.upsert("cs-gamma", {
        projects: ["CS"],
        allowed_actions: ["read", "write"],
      } as never);
    }
  });

  test("exact search authorizes lazily with the sequential semantics: an unauthorized repository raises only when reached", async () => {
    await repositories.upsert("cs-beta", { projects: ["CS"], allowed_actions: [] } as never);
    try {
      for (const e of ["typescript", "go"] as const) {
        config.codeIntelligence.searchEngine = e;
        // sharedHelper occurs once per repository: limit 2 reaches cs-beta, limit 1 is filled by cs-alpha.
        await assert.rejects(
          search.searchCodeExact("sharedHelper", scope(), 2),
          /unavailable or unauthorized/,
          e,
        );
        const hits = await search.searchCodeExact("sharedHelper", scope(), 1);
        assert.equal(hits.length, 1, e);
        assert.ok(
          hits.every((h) => h.repository === "cs-alpha"),
          e,
        );
      }
    } finally {
      await repositories.upsert("cs-beta", {
        projects: ["CS"],
        allowed_actions: ["read", "write"],
      } as never);
    }
  });

  test("a refused credential is raised, never answered by fallback", async () => {
    config.codeIntelligence.searchEngine = "go";
    const token = process.env.RETRIEVAL_INTERNAL_TOKEN;
    process.env.RETRIEVAL_INTERNAL_TOKEN = "y".repeat(64);
    try {
      await assert.rejects(search.searchSymbols("searchSymbols", scope(), 30), /refused \(401\)/);
      await assert.rejects(search.searchCodeExact("searchSymbols", scope(), 5), /refused \(401\)/);
    } finally {
      process.env.RETRIEVAL_INTERNAL_TOKEN = token;
    }
  });

  test("the internal API refuses paths, refs and scopes TypeScript would never send", async () => {
    const real = (await import("node:fs")).realpathSync;
    const base = {
      op: "exact",
      pattern: "root",
      limit: 5,
      unavailable: [],
      allowed_roots: [real(config.reposRoot), real(config.dataDir)],
      instance_id: config.instanceId,
      parser_version: parserVersion(),
      context_chars: 8000,
      limits: {
        max_file_bytes: 1 << 20,
        max_symbols: 100,
        max_files: 100,
        max_scan_bytes: 1 << 24,
        timeout_ms: 1000,
        excludes: [],
        include_generated: false,
        include_dependencies: false,
      },
    };
    const repo = (o: Record<string, unknown>) => ({
      name: "x",
      repository_id: 1,
      root: real(roots["cs-alpha"]),
      primary: real(roots["cs-alpha"]),
      default_branch: "main",
      run_id: null,
      ...o,
    });
    const link = join(config.reposRoot, "cs-link");
    symlinkSync(roots["cs-alpha"], link);
    for (const [why, body] of [
      [
        "outside the repositories",
        { ...base, repositories: [repo({ root: "/etc", primary: "/etc" })] },
      ],
      [
        "traversal",
        { ...base, repositories: [repo({ root: `${real(roots["cs-alpha"])}/../cs-beta` })] },
      ],
      ["symlinked checkout", { ...base, repositories: [repo({ root: link, primary: link })] }],
      [
        "not a checkout",
        {
          ...base,
          repositories: [repo({ root: real(config.reposRoot), primary: real(config.reposRoot) })],
        },
      ],
      [
        "ref injection",
        { ...base, repositories: [repo({ default_branch: "main --upload-pack=x" })] },
      ],
      [
        "too many repositories",
        { ...base, repositories: Array.from({ length: 31 }, (_, i) => repo({ name: `r${i}` })) },
      ],
      ["bad pattern", { ...base, pattern: "a\nb", repositories: [repo({})] }],
      ["unknown field", { ...base, extra: 1, repositories: [repo({})] }],
      // ADR 0007 §9: request roots only narrow platform-go's own trusted roots.
      [
        "allowed root outside the trusted roots",
        { ...base, allowed_roots: [real(join(config.reposRoot, ".."))], repositories: [repo({})] },
      ],
    ] as const) {
      const res = await retrievalService("/internal/v1/code-intelligence/search", body, 5000);
      assert.equal(res.status, 400, why);
    }
    const versionRes = await retrievalService(
      "/internal/v1/code-intelligence/search",
      { ...base, parser_version: "other", repositories: [] },
      5000,
    );
    assert.equal(versionRes.status, 409);
  });

  test("an unreachable or slow platform-go falls back to the TypeScript engine with the same authorization", async () => {
    config.codeIntelligence.searchEngine = "go";
    config.codeIntelligence.searchEngine = "typescript";
    const expected = strip(await search.searchSymbols("searchSymbols", scope(), 30));
    config.codeIntelligence.searchEngine = "go";
    const url = config.retrieval.semantic.url;
    config.retrieval.semantic.url = "http://127.0.0.1:9";
    try {
      const before = goSearchStats.fallbacks.unreachable ?? 0;
      assert.deepEqual(strip(await search.searchSymbols("searchSymbols", scope(), 30)), expected);
      assert.equal(goSearchStats.fallbacks.unreachable, before + 1);
      // Fallback never widens the scope: an unauthorized repository is still refused.
      await assert.rejects(
        search.searchSymbols("x", { repositories: ["cs-alpha"], allowed: [] }),
        /Unauthorized/,
      );
    } finally {
      config.retrieval.semantic.url = url;
    }
    // A platform-go that accepts the request and never answers: the deadline (timeoutMs) cancels it.
    const hang = createServer(() => {}).listen(0, "127.0.0.1");
    await new Promise((r) => hang.once("listening", r));
    const timeout = config.codeIntelligence.timeoutMs;
    config.codeIntelligence.timeoutMs = 2000;
    config.retrieval.semantic.url = `http://127.0.0.1:${(hang.address() as { port: number }).port}`;
    try {
      const before = goSearchStats.fallbacks.timeout ?? 0;
      assert.deepEqual(strip(await search.searchSymbols("searchSymbols", scope(), 30)), expected);
      assert.equal(
        goSearchStats.fallbacks.timeout,
        before + 1,
        "the deadline cancels Go; TypeScript answers",
      );
    } finally {
      hang.close();
      hang.closeAllConnections();
      config.retrieval.semantic.url = url;
      config.codeIntelligence.timeoutMs = timeout;
    }
  });

  test("rollback: the flag selects the engine per call; results are identical", async () => {
    const r = await both(() => search.searchSymbols("readSource safePath", scope(), 30));
    assert.deepEqual(r.go, r.ts);
    config.codeIntelligence.searchEngine = "typescript";
    const calls = goSearchStats.calls;
    await search.searchSymbols("readSource", scope(), 30);
    assert.equal(goSearchStats.calls, calls);
  });
}
