/**
 * KNOWLEDGE_IMPORT_ENGINE=go (ADR 0007): the TypeScript discovery and platform-go scan the same repositories and must
 * produce the same discovery, the same import reports, the same registry and the same embedding eligibility — at
 * every step of a fixture's life (conventions, wikis, skills with companions, identical skills across repositories,
 * user-level skills, secrets, oversized files, symlinks, renames, deletions, registry deletions, evolution conflicts,
 * partial scans). Plus the scan endpoint's own defenses (trusted roots, versions), fallback, credential refusal,
 * cancellation and concurrent imports. Fails without a Go toolchain.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { config } from "../src/config.ts";
import { goToolchain, requireGoToolchain, startPlatformGo } from "./fixtures/platformGo.ts";

if (!goToolchain()) {
  requireGoToolchain("knowledge import with the Go engine");
} else {
  // Before platform-go starts: its trusted roots include the user skills directory.
  const userDir = join(config.dataDir, "kb-user-skills");
  process.env.CLAUDE_USER_SKILLS_DIR = userDir;
  const { pool, q } = await import("../src/db/pool.ts");
  const { migrate } = await import("../src/db/migrate.ts");
  const { repositories } = await import("../src/repos/service.ts");
  const { knowledge } = await import("../src/knowledge/service.ts");
  const importer = await import("../src/knowledge/importer.ts");
  const { goKnowledgeScan, goKnowledgeStats, knowledgeScanRequest } =
    await import("../src/knowledge/goKnowledge.ts");
  const { retrievalService } = await import("../src/retrieval/semantic.ts");
  const { shareAllRepositoriesForTests } = await import("./fixtures/repositoryAccess.ts");

  const go = await startPlatformGo();
  after(async () => {
    go.stop();
    await pool.end();
  });

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const root = (name: string) => join(config.reposRoot, "kb-group", name);
  const put = (file: string, text: string | Buffer) => {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  };
  const outside = join(tmpdir(), `kb-outside-${process.pid}`);
  const skill = (name: string, extra = "") =>
    `---\nname: ${name}\ndescription: >-\n  Use for ${name};\n  multi-line description.\n---\n# ${name}\n\nSee [guide](references/guide.md).${extra}\n`;
  const REPOS = ["kb-api", "kb-worker", "kb-docs-wiki"];

  before(async () => {
    await migrate();
    await shareAllRepositoriesForTests();
    put(join(outside, "secret-notes.md"), "# outside\n\nnot part of any repository\n");
    mkdirSync(join(outside, "dir"), { recursive: true });
    put(join(outside, "dir", "x.md"), "# outside dir\n");

    // kb-api: conventions, identical AGENTS.md, skills (.claude wins over .agents), companions, rules, attacks.
    const api = root("kb-api");
    put(
      join(api, "CLAUDE.md"),
      "# kb-api\n\nThis file provides guidance to Claude Code.\n\nMoney is int64 VND — số tiền 😀.\n",
    );
    put(join(api, "AGENTS.md"), readFileSync(join(api, "CLAUDE.md")));
    put(join(api, "GEMINI.md"), "# Gemini\n\nDifferent text.\n");
    put(join(api, "docs", "CONVENTIONS.md"), "# Coding conventions\n\nUse typed errors.\n");
    put(join(api, "docs", "naming-convention.md"), "No heading here, just text.\n");
    put(join(api, "docs", "deep", "api-convention.md"), "# One level down: still a convention\n");
    put(
      join(api, "docs", "deep", "deeper", "too-deep-convention.md"),
      "# Two levels down: not walked\n",
    );
    for (const name of ["shared", "local", "both"]) {
      const base = join(api, ".claude", "skills", name);
      put(join(base, "SKILL.md"), skill(name, name === "local" ? " api-only" : ""));
      put(join(base, "references", "guide.md"), `# ${name} guide\n\nSteps.\n`);
      put(join(base, "references", "nested", "deep.md"), `Deep reference of ${name}.\n`);
      put(join(base, "scripts", "check.sh"), "#!/bin/sh\nexit 0\n");
      put(join(base, "image.png"), "not a companion");
    }
    put(join(api, ".agents", "skills", "both", "SKILL.md"), skill("both-agents"));
    // This installation's own checkout (self): its architecture and integration notes too.
    put(join(api, "docs", "architecture", "design.md"), "# Design\n\nLayers.\n");
    put(join(api, "docs", "integrations", "splunk.md"), "Splunk notes.\n");
    put(join(api, "docs", "frontend", "ui-quality-standards.md"), "# UI quality\n");
    put(join(api, "docs", "frontend", "other.md"), "# Not imported\n");
    put(join(api, ".agents", "skills", "agents-only", "agents-only.md"), skill("agents-only"));
    put(
      join(api, ".cursor", "rules", "go.mdc"),
      '---\ndescription: Go rules\nglobs: "**/*.go"\nalwaysApply: true\n---\n# Go\n\nwrap errors\n',
    );
    put(join(api, ".cursor", "rules", "plain.md"), "Rule without frontmatter.\n");
    put(join(api, "docs", "leak-convention.md"), "# Leak\n\npassword=Sup3rS3cretValue123\n");
    put(join(api, "docs", ".env-convention.md"), "# env\n");
    put(join(api, "docs", "huge-convention.md"), "# Huge\n\n" + "x".repeat((1 << 20) + 10));
    put(join(api, "docs", "long-convention.md"), "# Long\n\n" + "ü😀".repeat(25_000));
    put(
      join(api, "docs", "bad-utf8-convention.md"),
      Buffer.from([0x23, 0x20, 0x41, 0xff, 0xfe, 0xc3, 0x0a, 0x62]),
    );
    symlinkSync(join(outside, "secret-notes.md"), join(api, "docs", "escape-convention.md"));
    symlinkSync(join(outside, "dir"), join(api, ".claude", "skills", "local", "linked-out"));
    symlinkSync(
      join(api, "docs", "CONVENTIONS.md"),
      join(api, "docs", "inside-link-convention.md"),
    );
    symlinkSync(join(api, "missing.md"), join(api, "docs", "dangling-convention.md"));

    // kb-worker: same "shared" skill (identical → one item), a different "both" (variants → per-repository keys).
    const worker = root("kb-worker");
    put(join(worker, "CLAUDE.md"), "# kb-worker\n\nQueues.\n");
    for (const name of ["shared", "both"]) {
      const base = join(worker, ".claude", "skills", name);
      put(join(base, "SKILL.md"), skill(name, name === "both" ? " worker variant" : ""));
      if (name === "shared") {
        put(join(base, "references", "guide.md"), `# ${name} guide\n\nSteps.\n`);
        put(join(base, "references", "nested", "deep.md"), `Deep reference of ${name}.\n`);
        put(join(base, "scripts", "check.sh"), "#!/bin/sh\nexit 0\n");
      }
    }

    // kb-docs-wiki: wiki docs per project, conventions inlined for the code repositories, skipped files.
    const wiki = root("kb-docs-wiki");
    put(join(wiki, "docs", "CONVENTIONS.md"), "# Wiki conventions\n\nFor the code repositories.\n");
    put(
      join(wiki, "docs", "architecture", "overview.md"),
      "# Architecture overview\n\nServices.\n",
    );
    put(join(wiki, "docs", "partners", "ghn.md"), "Partner GHN without heading.\n");
    put(join(wiki, "docs", "sub", "team-convention.md"), "# Team convention (depth 2)\n");
    put(
      join(wiki, "docs", "sub", "deeper", "x-convention.md"),
      "# Deeper convention (imported as a doc)\n",
    );
    put(join(wiki, "docs", "CHANGELOG.md"), "# Changes\n");
    put(join(wiki, "docs", "authoring.md"), "# How to write\n");
    put(join(wiki, ".inventory", "conflicts.md"), "# Conflicts\n\nDocs vs code.\n");
    put(join(wiki, "README.md"), "# Not under docs/\n");

    // User-level skills: one unique, one copy of a repository skill (widens it), one unattended-unsafe, one secret.
    put(join(userDir, "user-unique", "SKILL.md"), skill("user-unique"));
    put(join(userDir, "shared", "SKILL.md"), skill("shared"));
    put(join(userDir, "pr", "SKILL.md"), skill("pr"));
    put(join(userDir, "leaky", "SKILL.md"), "# leaky\n\napi_key: AbCdEfGh12345678XyZ\n");
    put(join(userDir, "empty", "SKILL.md"), "");

    for (const name of REPOS) {
      execFileSync("git", ["-C", root(name), "init", "-q", "-b", config.baseBranch], { env });
      execFileSync("git", ["-C", root(name), "add", "-A"], { env });
      execFileSync("git", ["-C", root(name), "commit", "-qm", "base"], { env });
      await repositories.upsert(name, { path: `kb-group/${name}`, projects: ["KB"] });
    }
    execFileSync("mkfifo", [join(root("kb-api"), "docs", "fifo-convention.md")]); // never opened as a file
  });

  const repoArgs = () => REPOS.map((name) => ({ name, root: root(name), self: name === "kb-api" }));
  const engine = (e: "typescript" | "go") => (config.knowledge.importEngine = e);
  const dry = async (e: "typescript" | "go") => {
    engine(e);
    const calls = goKnowledgeStats.calls;
    const r = await importer.importFromRepositories({ dryRun: true });
    if (e === "go") assert.equal(goKnowledgeStats.calls, calls + 1, "answered by platform-go");
    return r;
  };
  /** The registry as both engines must leave it: items and current versions, without ids and timestamps. */
  const registry = async () =>
    q(
      pool,
      `SELECT i.key, i.category, i.scope_type, i.scope_ref, i.title, i.enabled, i.current_version,
              v.content, v.applicability, v.metadata, v.change_note
         FROM knowledge_items i JOIN knowledge_versions v ON v.item_id = i.id AND v.version = i.current_version
        WHERE i.owner_id IS NULL ORDER BY i.key`,
    );
  const eligible = async () =>
    (await q<{ key: string }>(pool, "SELECT key FROM retrieval.eligible_sources ORDER BY key")).map(
      (r) => r.key,
    );
  const clear = async () => {
    await q(pool, "DELETE FROM knowledge_proposals");
    await q(pool, "DELETE FROM knowledge_items");
    await q(pool, "DELETE FROM knowledge_deletions");
  };
  const commitAll = () => {
    for (const name of REPOS) {
      execFileSync("git", ["-C", root(name), "add", "-A"], { env });
      execFileSync("git", ["-C", root(name), "commit", "-qm", "change", "--allow-empty"], { env });
    }
  };

  test("discovery: both engines find the same candidates, skips and repositories", async () => {
    const ts = importer.discoverKnowledge(repoArgs(), userDir);
    engine("go");
    const viaGo = await goKnowledgeScan(repoArgs(), userDir);
    assert.ok(viaGo, "platform-go answered");
    assert.deepEqual(viaGo, ts);
    // The fixture exercised what it is meant to.
    const keys = ts.candidates.map((c) => c.key);
    for (const k of [
      "kb-api.claude",
      "kb-api.gemini",
      "kb-api.conventions",
      "kb-api.inside-link-convention",
      "kb-api.long-convention",
      "kb-api.api-convention",
      "kb-api.docs.architecture.design",
      "kb-api.docs.integrations.splunk",
      "kb-api.docs.frontend.ui-quality-standards",
      "kb-api.bad-utf8-convention",
      "skill.shared",
      "skill.shared.references.nested.deep",
      "skill.both.kb-api",
      "skill.both.kb-worker",
      "skill.agents-only",
      "user.skill.user-unique",
      "user.skill.pr",
      "kb-docs-wiki.inventory.conflicts",
      "kb-docs-wiki.docs.sub.deeper.x-convention",
    ])
      assert.ok(keys.includes(k), k);
    for (const k of [
      "kb-api.agents",
      "kb-api.leak-convention",
      "kb-api.huge-convention",
      "kb-api.escape-convention",
      "user.skill.shared",
      "user.skill.leaky",
      "kb-docs-wiki.docs.changelog",
      "kb-api.too-deep-convention",
      "kb-api.fifo-convention",
    ])
      assert.ok(!keys.includes(k), `not ${k}`);
    const reasons = ts.skipped.map((s) => `${s.path}: ${s.reason}`).join("\n");
    assert.match(reasons, /escape-convention\.md: symlink outside the repository/);
    assert.match(reasons, /linked-out: symlink outside the repository/);
    assert.match(reasons, /huge-convention\.md: larger than/);
    assert.match(reasons, /leak-convention\.md: looks like it contains credentials/);
    assert.match(reasons, /long-convention\.md: truncated to 60000 chars/);
    assert.match(reasons, /\.env-convention\.md: path excluded/);
    assert.match(reasons, /leaky\/SKILL\.md: looks like it contains credentials/);
    assert.ok(ts.candidates.every((c) => !c.content.includes("not part of any repository")));
    assert.deepEqual(ts.scanned, REPOS);
  });

  test("import: the same reports, registry and embedding eligibility from either engine; dry runs write nothing", async () => {
    const out: Record<string, unknown> = {};
    for (const e of ["typescript", "go"] as const) {
      await clear();
      assert.deepEqual(await dry(e), await dry(e === "go" ? "typescript" : "go"), "dry runs agree");
      assert.equal((await registry()).length, 0, "a dry run writes nothing");
      engine(e);
      const report = await importer.importFromRepositories();
      out[e] = { report, registry: await registry(), eligible: await eligible() };
    }
    assert.deepEqual(out.go, out.typescript);
    const reg = (
      out.go as { registry: Array<{ key: string; enabled: boolean; scope_type: string }> }
    ).registry;
    const item = (k: string) => reg.find((r) => r.key === k)!;
    assert.equal(
      item("user.skill.pr").enabled,
      false,
      "unattended-unsafe user skill imported disabled (TypeScript policy)",
    );
    assert.equal(
      item("skill.shared").scope_type,
      "ORGANIZATION",
      "a repository skill also in ~/.claude is widened",
    );
    assert.equal(
      item("kb-docs-wiki.conventions").scope_type,
      "PROJECT",
      "wiki conventions apply to its code repositories",
    );
    const keys = (out.go as { eligible: string[] }).eligible;
    assert.ok(!keys.includes("user.skill.pr"), "a disabled skill is never embedded");
  });

  test("incremental: unchanged, modified, added, deleted and renamed documents; both engines agree at every step", async () => {
    engine("go");
    const unchanged = await importer.importFromRepositories();
    assert.equal(
      unchanged.created + unchanged.updated + unchanged.retired,
      0,
      "nothing changed: no new version",
    );
    const versions = async () =>
      Number((await q(pool, "SELECT count(*)::int AS n FROM knowledge_versions"))[0].n);
    const before = await versions();
    const api = root("kb-api");
    put(join(api, "docs", "CONVENTIONS.md"), "# Coding conventions\n\nUse typed errors. Edited.\n"); // modified (unstaged)
    put(join(api, "docs", "new-convention.md"), "# New\n\nAdded, untracked.\n"); // added
    unlinkSync(join(api, "GEMINI.md")); // deleted
    renameSync(
      join(root("kb-docs-wiki"), "docs", "partners", "ghn.md"),
      join(root("kb-docs-wiki"), "docs", "partners", "ghn-express.md"),
    ); // renamed
    const ts = await dry("typescript");
    assert.deepEqual(await dry("go"), ts);
    const byKey = Object.fromEntries(ts.candidates.map((c) => [c.key, c.action]));
    assert.equal(byKey["kb-api.conventions"], "update");
    assert.equal(byKey["kb-api.new-convention"], "create");
    assert.equal(byKey["kb-api.gemini"], "retire");
    assert.equal(byKey["kb-docs-wiki.docs.partners.ghn-express"], "create");
    assert.equal(byKey["kb-docs-wiki.docs.partners.ghn"], "retire");
    engine("go");
    const r = await importer.importFromRepositories();
    assert.equal(await versions(), before + r.created + r.updated + r.retired);
    commitAll(); // staged/committed: same content, nothing new
    const again = await importer.importFromRepositories();
    assert.equal(again.created + again.updated + again.retired, 0);
  });

  test("governance stays in TypeScript: deleted items are not recreated, evolved items open a proposal", async () => {
    await knowledge.remove("kb-api.claude", { by: "admin", reason: "test" });
    const evolved = (await knowledge.latestShared(["kb-worker.claude"])).get("kb-worker.claude")!;
    await knowledge.update("kb-worker.claude", {
      content: "# kb-worker\n\nEvolved in the registry.\n",
      metadata: {
        ...evolved.metadata,
        evolution: { proposal_id: 1, base_source: evolved.metadata.source },
      },
      change_note: "approved proposal",
    });
    put(
      join(root("kb-worker"), "CLAUDE.md"),
      "# kb-worker\n\nQueues, edited in the repository too.\n",
    );
    const ts = await dry("typescript");
    assert.deepEqual(await dry("go"), ts);
    assert.ok(ts.skipped.some((s) => s.reason === "kb-api.claude was deleted from the registry"));
    assert.equal(ts.candidates.find((c) => c.key === "kb-worker.claude")!.action, "conflict");
    engine("go");
    const r = await importer.importFromRepositories();
    assert.ok(
      r.candidates.find((c) => c.key === "kb-worker.claude")!.proposal_id,
      "a proposal, not an overwrite",
    );
    assert.match(
      (await knowledge.get("kb-worker.claude"))!.versions[0].content,
      /Evolved in the registry/,
    );
    assert.equal(await knowledge.get("kb-api.claude"), undefined, "still deleted");
  });

  test("unreadable is not deleted: permission errors make the scan incomplete and retire nothing; deletions still retire", async () => {
    engine("go");
    await importer.importFromRepositories(); // settle the registry on the current files
    const api = root("kb-api");
    put(join(api, ".agents", "skills", "shared", "SKILL.md"), skill("shared", " agents copy"));
    engine("typescript");
    await importer.importFromRepositories();
    const lock = [
      join(api, "docs"), // directory: readdir EACCES
      join(api, "CLAUDE.md"), // file: open EACCES
      join(api, ".claude", "skills", "shared", "SKILL.md"), // preferred skill file: no fallback to .agents
      join(api, ".claude", "skills", "local", "references", "guide.md"), // companion: the skill is not split
    ];
    for (const p of lock) execFileSync("chmod", ["000", p]);
    try {
      const ts = await dry("typescript");
      assert.deepEqual(await dry("go"), ts);
      assert.deepEqual(ts.incomplete, ["kb-api"]);
      for (const p of ["kb-api/docs", "kb-api/CLAUDE.md", "kb-api/.claude/skills/shared/SKILL.md"])
        assert.ok(
          ts.skipped.some((x) => x.path === p && x.reason === "unreadable (EACCES)"),
          `${p} reported unreadable`,
        );
      const actions = Object.fromEntries(ts.candidates.map((c) => [c.key, c.action]));
      assert.ok(
        !Object.values(actions).includes("retire"),
        "nothing retired from an unreadable scan",
      );
      assert.equal(
        actions["skill.shared"],
        undefined,
        "neither replaced by the .agents copy nor narrowed",
      );
      assert.ok(
        ts.skipped.some(
          (x) => x.reason === "skill.shared not updated: the scan of kb-api is incomplete",
        ),
      );
      engine("go");
      const r = await importer.importFromRepositories();
      assert.equal(r.retired, 0);
      assert.deepEqual(r.incomplete, ["kb-api"]);
      assert.ok((await knowledge.get("kb-api.conventions"))?.enabled, "still enabled");
    } finally {
      for (const p of lock) execFileSync("chmod", ["u+rwX", p]);
      execFileSync("chmod", ["-R", "u+rwX", join(api, "docs")]);
      rmSync(join(api, ".agents", "skills", "shared"), { recursive: true, force: true });
    }
    // Readable again and one file really deleted: that one is retired, nothing else.
    unlinkSync(join(api, "docs", "naming-convention.md"));
    const ts = await dry("typescript");
    assert.deepEqual(await dry("go"), ts);
    assert.equal(ts.incomplete, undefined);
    assert.deepEqual(
      ts.candidates.filter((c) => c.action === "retire").map((c) => c.key),
      ["kb-api.naming-convention"],
    );
  });

  test("a partial scan never retires: entry budget exhausted, or a repository gone from disk", async () => {
    const saved = importer.SCAN_LIMITS.maxEntries;
    importer.SCAN_LIMITS.maxEntries = 3;
    try {
      const ts = await dry("typescript");
      const viaGo = await dry("go");
      assert.deepEqual(viaGo, ts);
      assert.ok(ts.incomplete && ts.incomplete.length > 0, "reported incomplete");
      for (const c of ts.candidates.filter((x) => x.action === "retire"))
        assert.ok(
          !c.repos.some((repo) => ts.incomplete!.includes(repo)),
          `${c.key} retired from an incomplete scan`,
        );
    } finally {
      importer.SCAN_LIMITS.maxEntries = saved;
    }
  });

  test("revoked or disabled repositories are neither scanned nor retired", async () => {
    await repositories.upsert("kb-worker", { enabled: false });
    try {
      const ts = await dry("typescript");
      assert.deepEqual(await dry("go"), ts);
      assert.ok(
        !ts.candidates.some((c) => c.key.startsWith("kb-worker.")),
        "not scanned, not retired",
      );
      assert.ok(!ts.candidates.some((c) => c.repos.includes("kb-worker")), "no evidence from it");
    } finally {
      await repositories.upsert("kb-worker", { enabled: true });
    }
  });

  test("concurrent imports are serialized: no duplicate versions, no unique violations", async () => {
    engine("go");
    put(join(root("kb-api"), "docs", "concurrent-convention.md"), "# Concurrent\n\nOnce.\n");
    const [a, b] = await Promise.all([
      importer.importFromRepositories(),
      importer.importFromRepositories(),
    ]);
    assert.equal(a.created + b.created, 1, "created once");
    const rows = await q(
      pool,
      "SELECT count(*)::int AS n FROM knowledge_versions v JOIN knowledge_items i ON i.id = v.item_id WHERE i.key = 'kb-api.concurrent-convention'",
    );
    assert.equal(rows[0].n, 1);
  });

  test("the scan endpoint reads only inside the trusted roots and refuses what TypeScript never sends", async () => {
    const valid = knowledgeScanRequest(repoArgs(), userDir);
    const post = (body: unknown) => retrievalService("/internal/v1/knowledge/scan", body, 30_000);
    assert.equal((await post(valid)).status, 200);
    mkdirSync(join(outside, "repo", ".git"), { recursive: true });
    const link = join(config.reposRoot, "kb-link-out");
    symlinkSync(join(outside, "repo"), link);
    for (const [why, body] of [
      [
        "outside the trusted roots",
        { ...valid, repositories: [{ name: "x", root: join(outside, "repo"), self: false }] },
      ],
      [
        "symlinked out of the trusted roots",
        { ...valid, repositories: [{ name: "x", root: link, self: false }] },
      ],
      [
        "traversal",
        {
          ...valid,
          repositories: [{ name: "x", root: `${root("kb-api")}/../kb-api`, self: false }],
        },
      ],
      [
        "not a checkout",
        { ...valid, repositories: [{ name: "x", root: config.reposRoot, self: false }] },
      ],
      ["user skills outside", { ...valid, user_skills_dir: outside }],
      [
        "duplicate names",
        { ...valid, repositories: [...valid.repositories, valid.repositories[0]] },
      ],
      ["limits", { ...valid, limits: { ...valid.limits, max_file_bytes: 1 << 30 } }],
      ["unknown field", { ...valid, extra: true }],
    ] as const)
      assert.equal((await post(body)).status, 400, why);
    assert.equal((await post({ ...valid, version: "knowledge-scan-0" })).status, 409);
    rmSync(link);
  });

  test("fallback: unreachable or slow platform-go → TypeScript discovery; a refused credential is raised", async () => {
    const expected = importer.discoverKnowledge(repoArgs(), userDir);
    engine("go");
    const url = config.retrieval.semantic.url;
    try {
      config.retrieval.semantic.url = "http://127.0.0.1:9";
      const before = goKnowledgeStats.fallbacks.unreachable ?? 0;
      assert.equal(await goKnowledgeScan(repoArgs(), userDir), null);
      assert.equal(goKnowledgeStats.fallbacks.unreachable, before + 1);
      const scan = await importer.scanRepositories();
      assert.deepEqual(
        [...scan.scanned].sort(),
        [...expected.scanned].sort(),
        "TypeScript answered",
      );
      config.retrieval.semantic.url = url;
      const token = process.env.RETRIEVAL_INTERNAL_TOKEN;
      process.env.RETRIEVAL_INTERNAL_TOKEN = "x".repeat(64);
      try {
        await assert.rejects(goKnowledgeScan(repoArgs(), userDir), /refused \(401\)/);
      } finally {
        process.env.RETRIEVAL_INTERNAL_TOKEN = token;
      }
      // A server that accepts and never answers: the request deadline cancels it.
      const hang = createServer(() => {}).listen(0, "127.0.0.1");
      await new Promise((r) => hang.once("listening", r));
      config.retrieval.semantic.url = `http://127.0.0.1:${(hang.address() as { port: number }).port}`;
      const deadline = importer.SCAN_LIMITS.deadlineMs;
      importer.SCAN_LIMITS.deadlineMs = 200; // request timeout = deadline + 10 s
      try {
        const t = Date.now();
        assert.equal(await goKnowledgeScan(repoArgs(), userDir), null);
        assert.ok(Date.now() - t < 15_000);
        assert.ok((goKnowledgeStats.fallbacks.timeout ?? 0) >= 1);
      } finally {
        importer.SCAN_LIMITS.deadlineMs = deadline;
        hang.close();
        hang.closeAllConnections();
      }
    } finally {
      config.retrieval.semantic.url = url;
    }
  });

  test("a canceled scan request frees its slot; later scans succeed", async () => {
    const body = knowledgeScanRequest(repoArgs(), userDir);
    for (let i = 0; i < 4; i++) {
      const ac = new AbortController();
      const p = retrievalService("/internal/v1/knowledge/scan", body, 30_000, ac.signal).catch(
        (e) => e,
      );
      ac.abort();
      assert.equal((await p).name, "AbortError");
    }
    const ok = await retrievalService("/internal/v1/knowledge/scan", body, 30_000);
    assert.equal(ok.status, 200);
    const parsed = await ok.json();
    assert.ok(parsed.metrics.files_read > 0);
    rmSync(outside, { recursive: true, force: true });
  });
}
