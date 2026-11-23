/**
 * Go code-search boundary coverage: authorization, redaction, and service failures. The indexing and worktree
 * behavior in code-intelligence.integration.ts has its own fixture and runs once in that suite.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { goToolchain, requireGoToolchain, startPlatformGo } from "./fixtures/platformGo.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";
import { pool } from "../src/db/pool.ts";

if (!goToolchain()) {
  requireGoToolchain("code search with the Go engine");
} else {
  let go: Awaited<ReturnType<typeof startPlatformGo>> | undefined;
  after(async () => {
    go?.stop();
    await pool.end();
  });
  const search = await import("../src/codeIntelligence/search.ts");
  const { goSearchStats } = await import("../src/codeIntelligence/goSearch.ts");
  const { repositories } = await import("../src/repos/service.ts");
  const { indexRepository } = await import("../src/codeIntelligence/indexer.ts");
  const { retrievalService } = await import("../src/retrieval/semantic.ts");
  const { parserVersion } = await import("../src/codeIntelligence/parser.ts");

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const git = (root: string, ...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env }).trim();
  const repos = ["cs-alpha", "cs-beta", "cs-gamma"];
  const roots: Record<string, string> = {};
  before(async () => {
    config.codeIntelligence.enabled = true;
    go = await startPlatformGo();
    await shareAllRepositoriesForTests();
    for (const [i, name] of repos.entries()) {
      const root = join(config.reposRoot, name);
      mkdirSync(join(root, "src"), { recursive: true });
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
  });

  const scope = (extra: Record<string, unknown> = {}) => ({
    repositories: repos,
    allowed: repos,
    provision: false,
    ...extra,
  });
  test("secrets in snippets are redacted", async () => {
    const hits = await search.searchCodeExact("hunter2", scope(), 5, { anyFile: true });
    assert.ok(hits.length > 0);
    for (const h of hits) assert.doesNotMatch(h.snippet!, /hunter2/);
    const ctx = await search.buildCodeContext("sharedHelper1", scope());
    assert.doesNotMatch(ctx.body, /hunter2/);
  });

  test("a revoked repository permission is resolved by TypeScript and never reaches Go", async () => {
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
      // sharedHelper occurs once per repository. A limit of two reaches cs-beta, one is filled by cs-alpha.
      await assert.rejects(
        search.searchCodeExact("sharedHelper", scope(), 2),
        /unavailable or unauthorized/,
      );
      const hits = await search.searchCodeExact("sharedHelper", scope(), 1);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].repository, "cs-alpha");
    } finally {
      await repositories.upsert("cs-beta", {
        projects: ["CS"],
        allowed_actions: ["read", "write"],
      } as never);
    }
  });

  test("a refused credential is raised, never answered by fallback", async () => {
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

  test("an unreachable or slow platform-go fails the search with its reason (no second engine)", async () => {
    const url = config.retrieval.semantic.url;
    config.retrieval.semantic.url = "http://127.0.0.1:9";
    try {
      const before = goSearchStats.failures.unreachable ?? 0;
      await assert.rejects(
        search.searchSymbols("searchSymbols", scope(), 30),
        /Code search is unavailable/,
      );
      assert.equal(goSearchStats.failures.unreachable, before + 1);
      // The scope is still authorized first.
      await assert.rejects(
        search.searchSymbols("x", { repositories: ["cs-alpha"], allowed: [] }),
        /Unauthorized/,
      );
    } finally {
      config.retrieval.semantic.url = url;
    }
  });
}
