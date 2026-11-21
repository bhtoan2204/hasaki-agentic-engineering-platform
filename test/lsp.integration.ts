/**
 * LSP semantic navigation (P1-B). Real gopls (skipped when it is not installed) and the TypeScript server, on
 * repositories registered in the platform registry, through `navigate()` — authorization, path validation, symbol
 * positioning, freshness and budgets included. Language servers run in the OS sandbox when this host has one,
 * otherwise with the explicit operator opt-in (`lsp.allowUnsandboxed`), which the tests turn on only in that case.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { repositories } from "../src/repos/service.ts";
import { probeIsolation } from "../src/agent/isolation.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";
import {
  navigate,
  setNavigateHookForTests,
  type NavResult,
} from "../src/codeIntelligence/lsp/navigate.ts";
import {
  closeAllSessions,
  sessionCount,
  killSessionsForTests,
  sessionPidsForTests,
} from "../src/codeIntelligence/lsp/sessions.ts";

const hasGopls = spawnSync("gopls", ["version"]).status === 0;
const noGo = hasGopls ? false : "gopls is not installed on this host";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@e.x",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@e.x",
    },
  });

const GO_MAIN = `package main

import (
\t"fmt"

\tpay "example.com/fix/payment"
\t"example.com/fix/refund"
)

func main() {
\tfmt.Println(pay.Process("a"))
\tfmt.Println(refund.Process("b"))
}
`;
const files: Record<string, Record<string, string>> = {
  "lsp-go": {
    "go.mod": "module example.com/fix\n\ngo 1.22\n",
    "payment/process.go": `package payment\n\n// Process charges an order.\nfunc Process(id string) string { return "pay:" + id }\n`,
    "refund/process.go": `package refund\n\n// Process refunds an order.\nfunc Process(id string) string { return "refund:" + id }\n`,
    "refund/use.go": `package refund\n\nfunc Twice(id string) string { return Process(id) + Process(id) }\n`,
    "main.go": GO_MAIN,
  },
  "lsp-ts": {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "es2022",
        module: "esnext",
        moduleResolution: "bundler",
      },
    }),
    "src/a.ts":
      "export function compute(n: number) {\n  return n * 2;\n}\nexport class Store {\n  save() {\n    return 1;\n  }\n}\n",
    "src/b.ts":
      'import { compute as calc } from "./a";\nimport { Store } from "./a";\nexport const v = calc(2);\nexport const s = new Store().save();\nexport const broken: number = "text";\n',
    "src/c.ts": 'import { compute } from "./a";\nexport const w = compute(3);\n',
  },
};
const root = (repo: string) => join(config.reposRoot, repo);
/** 1-based line/column of `needle` (+offset) in the file text. */
function at(text: string, needle: string, offset = 0) {
  const i = text.indexOf(needle);
  assert.ok(i >= 0, needle);
  const before = text.slice(0, i + offset);
  const line = before.split("\n").length;
  return { line, character: i + offset - before.lastIndexOf("\n") };
}
const nav = (req: Parameters<typeof navigate>[0], allowed = ["lsp-go", "lsp-ts"]) =>
  navigate(req, { allowed });
const paths = (r: NavResult) => r.locations.map((l) => `${l.path}:${l.line}`).sort();

before(async () => {
  await migrate();
  for (const [repo, tree] of Object.entries(files)) {
    for (const [p, body] of Object.entries(tree)) {
      mkdirSync(join(root(repo), p, ".."), { recursive: true });
      writeFileSync(join(root(repo), p), body);
    }
    git(root(repo), "init", "-q", "-b", config.baseBranch);
    git(root(repo), "add", ".");
    git(root(repo), "commit", "-qm", "fixture");
    await repositories.upsert(repo, { projects: ["LSP"] });
  }
  await shareAllRepositoriesForTests();
  config.lsp.enabled = true;
  if (!(await probeIsolation(true)).available) config.lsp.allowUnsandboxed = true;
});
after(async () => {
  await closeAllSessions();
  await pool.end();
});

test(
  "Go: definition resolves the aliased import to the right one of two same-name functions",
  { skip: noGo },
  async () => {
    const p = at(GO_MAIN, "pay.Process", 4);
    const r = await nav({ repository: "lsp-go", path: "main.go", operation: "definition", ...p });
    assert.equal(r.status, "ok", r.error ?? "");
    assert.deepEqual(paths(r), ["payment/process.go:4"]);
    const q = at(GO_MAIN, "refund.Process", 7);
    const s = await nav({ repository: "lsp-go", path: "main.go", operation: "definition", ...q });
    assert.deepEqual(paths(s), ["refund/process.go:4"]);
    assert.equal(r.provenance?.root_kind, "checkout");
    assert.match(r.provenance?.file_sha256 ?? "", /^[0-9a-f]{64}$/);
  },
);

test(
  "Go: references across files, and the standard library is counted as external",
  { skip: noGo },
  async () => {
    const text = files["lsp-go"]["refund/process.go"];
    const r = await nav({
      repository: "lsp-go",
      path: "refund/process.go",
      operation: "references",
      ...at(text, "func Process", 5),
    });
    assert.equal(r.status, "ok", r.error ?? "");
    assert.deepEqual(paths(r), [
      "main.go:12",
      "refund/process.go:4",
      "refund/use.go:3",
      "refund/use.go:3",
    ]);
    const d = await nav({
      repository: "lsp-go",
      path: "main.go",
      operation: "definition",
      ...at(GO_MAIN, "fmt.Println", 4),
    });
    assert.equal(d.status, "ok");
    assert.deepEqual(d.locations, []);
    assert.equal(d.external, 1, "fmt.Println lives outside the repository");
  },
);

test(
  "a symbol name shared by declarations is ambiguous, never guessed; a unique one is positioned",
  { skip: noGo },
  async () => {
    const both = await nav({
      repository: "lsp-go",
      path: "refund/use.go",
      operation: "definition",
      symbol: "Nope",
    });
    assert.equal(both.status, "not_found");
    const r = await nav({
      repository: "lsp-go",
      path: "refund/use.go",
      operation: "references",
      symbol: "Twice",
    });
    assert.equal(r.status, "ok", r.error ?? "");
    assert.deepEqual(paths(r), ["refund/use.go:3"]);
  },
);

test("TypeScript: definition across files through an import alias, and references", async () => {
  const b = files["lsp-ts"]["src/b.ts"];
  const r = await nav({
    repository: "lsp-ts",
    path: "src/b.ts",
    operation: "definition",
    ...at(b, "calc(2)"),
  });
  assert.equal(r.status, "ok", r.error ?? "");
  assert.deepEqual(paths(r), ["src/a.ts:1"]);
  const refs = await nav({
    repository: "lsp-ts",
    path: "src/a.ts",
    operation: "references",
    symbol: "compute",
  });
  assert.equal(refs.status, "ok", refs.error ?? "");
  // `import { compute as calc }` holds two references on one line: the imported name and its local alias.
  assert.deepEqual(
    refs.locations.map((l) => `${l.path}:${l.line}:${l.character}`),
    [
      "src/a.ts:1:17",
      "src/b.ts:1:10",
      "src/b.ts:1:21",
      "src/b.ts:3:18",
      "src/c.ts:1:10",
      "src/c.ts:2:18",
    ],
  );
  const syms = await nav({ repository: "lsp-ts", path: "src/a.ts", operation: "document_symbols" });
  assert.deepEqual(
    syms.locations.map((l) => l.name),
    ["compute", "Store", "save"],
  );
  const diag = await nav({ repository: "lsp-ts", path: "src/b.ts", operation: "diagnostics" });
  assert.equal(diag.status, "ok");
  assert.equal(diag.diagnostics?.length, 1);
  assert.equal(diag.diagnostics?.[0].line, 5);
});

test("an uncommitted edit is what the next answer is based on", async () => {
  const a = join(root("lsp-ts"), "src/a.ts");
  writeFileSync(a, "// moved down\n\n" + files["lsp-ts"]["src/a.ts"]);
  try {
    const b = files["lsp-ts"]["src/b.ts"];
    const r = await nav({
      repository: "lsp-ts",
      path: "src/b.ts",
      operation: "definition",
      ...at(b, "calc(2)"),
    });
    assert.deepEqual(paths(r), ["src/a.ts:3"]);
  } finally {
    writeFileSync(a, files["lsp-ts"]["src/a.ts"]);
  }
});

test("a file changed while the request was in flight is reported stale, without locations", async () => {
  const b = join(root("lsp-ts"), "src/b.ts");
  setNavigateHookForTests(() => writeFileSync(b, files["lsp-ts"]["src/b.ts"] + "\n// edited\n"));
  try {
    const r = await nav({
      repository: "lsp-ts",
      path: "src/b.ts",
      operation: "definition",
      ...at(files["lsp-ts"]["src/b.ts"], "calc(2)"),
    });
    assert.equal(r.status, "stale");
    assert.deepEqual(r.locations, []);
  } finally {
    setNavigateHookForTests(undefined);
    writeFileSync(b, files["lsp-ts"]["src/b.ts"]);
  }
});

test("unauthorized repositories, traversal, absolute paths, secrets and symlinks are refused before any server", async () => {
  assert.equal(
    (
      await nav({ repository: "lsp-ts", path: "src/a.ts", operation: "document_symbols" }, [
        "lsp-go",
      ])
    ).status,
    "unauthorized",
  );
  for (const path of ["../lsp-go/main.go", "/etc/passwd", ".env"])
    assert.equal(
      (await nav({ repository: "lsp-ts", path, operation: "document_symbols" })).status,
      "invalid",
      path,
    );
  symlinkSync("/etc/hostname", join(root("lsp-ts"), "src/link.ts"));
  assert.equal(
    (await nav({ repository: "lsp-ts", path: "src/link.ts", operation: "document_symbols" }))
      .status,
    "invalid",
  );
  assert.equal(
    (
      await nav({
        repository: "lsp-ts",
        path: "README.md",
        operation: "definition",
        line: 1,
        character: 1,
      })
    ).status,
    "unsupported",
  );
});

test("results are bounded", async () => {
  const old = config.lsp.maxResults;
  config.lsp.maxResults = 2;
  try {
    const r = await nav({
      repository: "lsp-ts",
      path: "src/a.ts",
      operation: "references",
      symbol: "compute",
    });
    assert.equal(r.locations.length, 2);
    assert.equal(r.more, 4, "6 references in all");
  } finally {
    config.lsp.maxResults = old;
  }
});

test("a missing language server is a typed unavailable answer", async () => {
  const old = config.lsp.gopls;
  config.lsp.gopls = "/nonexistent/gopls";
  try {
    await closeAllSessions();
    const r = await nav({ repository: "lsp-go", path: "main.go", operation: "document_symbols" });
    assert.equal(r.status, "unavailable");
  } finally {
    config.lsp.gopls = old;
  }
});

test("a crashed server is replaced on the next request; closing leaves no process", async () => {
  const req = { repository: "lsp-ts", path: "src/a.ts", operation: "document_symbols" as const };
  assert.equal((await nav(req)).status, "ok");
  killSessionsForTests();
  assert.equal((await nav(req)).status, "ok", "a fresh session after the crash");
  assert.ok(sessionCount() >= 1);
  const pids = await sessionPidsForTests();
  assert.ok(pids.length >= 1);
  await closeAllSessions();
  assert.equal(sessionCount(), 0);
  const alive = pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  assert.deepEqual(alive, [], "every server process this platform started is gone");
});

test("an aborted request is canceled", async () => {
  const ac = new AbortController();
  ac.abort();
  const r = await navigate(
    { repository: "lsp-ts", path: "src/a.ts", operation: "document_symbols" },
    { allowed: ["lsp-ts"], signal: ac.signal },
  );
  assert.equal(r.status, "canceled");
});

test("disabled LSP is unsupported", async () => {
  config.lsp.enabled = false;
  try {
    assert.equal(
      (await nav({ repository: "lsp-ts", path: "src/a.ts", operation: "document_symbols" })).status,
      "unsupported",
    );
  } finally {
    config.lsp.enabled = true;
  }
});

test("without the OS sandbox a language server starts only with the explicit operator opt-in", async () => {
  const { setIsolationRuntimeForTests } = await import("../src/agent/isolation.ts");
  const opt = config.lsp.allowUnsandboxed;
  await closeAllSessions();
  setIsolationRuntimeForTests({
    available: false,
    bwrap: null,
    namespaces: false,
    network_isolated: false,
    cgroup: "none",
    rlimits: false,
    problems: ["simulated host without bubblewrap"],
    version: "test",
    checked_at: new Date().toISOString(),
  });
  try {
    config.lsp.allowUnsandboxed = false;
    const r = await nav({ repository: "lsp-ts", path: "src/a.ts", operation: "document_symbols" });
    assert.equal(r.status, "unavailable");
    assert.match(r.error ?? "", /allowUnsandboxed/);
  } finally {
    setIsolationRuntimeForTests(null);
    config.lsp.allowUnsandboxed = opt;
    await closeAllSessions();
  }
});

test("surfaces: workflow navigate_code and Chat code.navigate answer within their own repository scope", async () => {
  const { executeContextTool } = await import("../src/agent/contextTools.ts");
  const { toolsForMode } = await import("../src/chat/tools.ts");
  const { advertisedContextTools } = await import("../src/agent/contextToolSchemas.ts");
  assert.ok(advertisedContextTools().some((t) => t.name === "navigate_code"));
  const b = files["lsp-ts"]["src/b.ts"];
  const env = { allowed: ["lsp-ts"], selected: ["lsp-ts"], runId: 0 } as never;
  const wf = (await executeContextTool(
    "navigate_code",
    {
      repository: "lsp-ts",
      path: "src/b.ts",
      operation: "definition",
      ...at(b, "calc(2)"),
    } as never,
    env,
  )) as NavResult;
  assert.equal(wf.status, "ok", wf.error ?? "");
  assert.deepEqual(paths(wf), ["src/a.ts:1"]);
  const outside = (await executeContextTool(
    "navigate_code",
    { repository: "lsp-go", path: "main.go", operation: "document_symbols" } as never,
    env,
  )) as NavResult;
  assert.equal(outside.status, "unauthorized");

  const tool = toolsForMode("ASK").find((t) => t.name === "code.navigate")!;
  const ctx = {
    binding: { userId: 1, conversationId: 1, turnId: 1, mode: "ASK", repositories: [] },
    readable: ["lsp-ts"],
    scoped: [],
    signal: new AbortController().signal,
  } as never;
  const chatAnswer = (await tool.run(
    tool.args.parse({
      repository: "lsp-ts",
      path: "src/a.ts",
      operation: "references",
      symbol: "compute",
    }),
    ctx,
  )) as { data: NavResult };
  assert.equal(chatAnswer.data.status, "ok");
  assert.equal(chatAnswer.data.locations.length, 6);
  await assert.rejects(
    tool.run(
      tool.args.parse({ repository: "lsp-go", path: "main.go", operation: "document_symbols" }),
      ctx,
    ),
    /not accessible/,
  );

  config.lsp.enabled = false;
  try {
    assert.ok(
      !advertisedContextTools().some((t) => t.name === "navigate_code"),
      "not advertised when off",
    );
  } finally {
    config.lsp.enabled = true;
  }
});
