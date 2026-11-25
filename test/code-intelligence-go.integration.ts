/**
 * Index publishing and lease fencing through the Go API against this file's database. Fails without a Go toolchain
 * (PLATFORM_ALLOW_MISSING_GO=1 skips it explicitly outside CI).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../src/config.ts";
import { goToolchain, requireGoToolchain, startPlatformGo } from "./fixtures/platformGo.ts";

if (!goToolchain()) {
  requireGoToolchain("code intelligence with the Go engine");
} else {
  const go = await startPlatformGo();
  after(go.stop);
  const { pool, one, q } = await import("../src/db/pool.ts");
  const { repositories } = await import("../src/repos/service.ts");
  const { retrievalService } = await import("../src/retrieval/semantic.ts");
  const { parserVersion } = await import("../src/codeIntelligence/parser.ts");
  const fixtures = resolve(
    import.meta.dirname,
    "../go/internal/codeintelligence/testdata/parity/src",
  );
  const repo = async (name: string) => {
    const root = join(config.reposRoot, name);
    mkdirSync(root, { recursive: true });
    cpSync(fixtures, root, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    git("init", "-q", "-b", config.baseBranch);
    git("add", ".");
    git("commit", "-qm", "base");
    await repositories.upsert(name, { projects: ["CI"] });
    return { root, git };
  };
  test("a stale fence publishes nothing, and a canceled job leaves no snapshot", async () => {
    const { root, git } = await repo("ci-go-fence");
    const id = (await repositories.get("ci-go-fence"))!.id;
    const base = String(git("rev-parse", "HEAD")).trim();
    const body = (fence: unknown) => ({
      repository_id: id,
      primary: root,
      root,
      base,
      run_id: null,
      parser_version: parserVersion(),
      instance_id: config.instanceId,
      fence,
      limits: {
        max_file_bytes: config.codeIntelligence.maxFileBytes,
        max_symbols: config.codeIntelligence.maxSymbols,
        max_files: config.codeIntelligence.maxFiles,
        max_scan_bytes: config.codeIntelligence.maxScanBytes,
        timeout_ms: config.codeIntelligence.timeoutMs,
        excludes: [],
        include_generated: false,
        include_dependencies: false,
      },
    });
    const [job] = await q(
      pool,
      `INSERT INTO code_intelligence.runs(repository_id,instance_id,scope_key,status,fencing_token,lease_expires_at)
       VALUES($1,$2,'fence-test','running',5,now()+interval '1 minute') RETURNING id`,
      [id, config.instanceId],
    );
    const stale = await retrievalService(
      "/internal/v1/code-intelligence/index",
      body({ id: job.id, token: 4, instance_id: config.instanceId, instance_session: "x" }),
      60_000,
    );
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /lease lost/);
    const snapshots = async () =>
      (await one(
        pool,
        "SELECT count(*)::int AS n FROM code_intelligence.snapshots WHERE repository_id=$1",
        [id],
      ))!.n;
    assert.equal(await snapshots(), 0, "nothing published under a stale fence");
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      retrievalService("/internal/v1/code-intelligence/index", body(null), 60_000, ac.signal),
    );
    assert.equal(await snapshots(), 0);
    const wrong = await retrievalService(
      "/internal/v1/code-intelligence/index",
      { ...body(null), parser_version: "extractor-9/other" },
      60_000,
    );
    assert.equal(wrong.status, 409, "an index version this extractor does not produce is refused");
  });
}
