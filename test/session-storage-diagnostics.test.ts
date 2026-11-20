import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { agentSessionStorageDiagnostics } from "../src/agent/sessionDiagnostics.ts";
import type { Ctx } from "../src/api/routes.ts";

const DAY = 24 * 60 * 60 * 1000;

function withRoot(fn: (root: string) => Promise<void>) {
  return async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ctp-session-diag-")));
    try {
      await fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function write(path: string, content = "x") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

const diagnose = (root: string, now?: number) =>
  agentSessionStorageDiagnostics({
    dataDir: join(root, "data"),
    homeDir: join(root, "home"),
    includeDatabase: false,
    now,
  });

const completionProject = (root: string) =>
  join(
    root,
    "home",
    ".claude",
    "projects",
    join(root, "data", "completion-sessions").replace(/[^a-zA-Z0-9]/g, "-"),
  );

test(
  "missing storage reports zero usage for every provider without throwing",
  withRoot(async (root) => {
    const report = await diagnose(root);
    assert.equal(report.session_count, 0);
    assert.equal(report.file_count, 0);
    assert.equal(report.disk_usage_bytes, 0);
    assert.equal(report.database_sessions, null);
    for (const p of ["claude", "cursor", "codex", "antigravity", "copilot"] as const) {
      assert.equal(report.by_provider[p].available, false);
      assert.equal(report.by_provider[p].session_count, 0);
    }
    const sandbox = report.scanned_directories.find((d) => d.path.endsWith("sandbox"));
    assert.equal(sandbox?.status, "missing");
  }),
);

test(
  "session counts follow each provider's storage layout, not arbitrary entries",
  withRoot(async (root) => {
    const run = join(root, "data", "sandbox", "run-7");
    write(join(run, "claude", ".claude", "projects", "-work-repo", "s1.jsonl"));
    write(join(run, "claude", ".claude", "projects", "-work-repo", "s2.jsonl"));
    write(join(run, "claude", ".claude", "settings.json"));
    write(join(run, "claude", ".claude", "projects", "-work-repo", "notes.txt"));
    write(join(run, "codex", ".codex", "sessions", "2026", "11", "20", "rollout-a.jsonl"));
    write(join(run, "codex", ".codex", "config.toml"));
    write(join(run, "codex", ".codex", "log", "codex-tui.log"));
    write(join(run, "cursor", ".cursor", "chats", "ws1", "chat1", "store.db"));
    write(join(run, "copilot", ".copilot", "session-state", "s1", "events.jsonl"));
    write(join(run, "antigravity", ".gemini", "antigravity-cli", "brain", "0".repeat(36), "a"));
    write(join(run, "antigravity", ".gemini", "antigravity-cli", "antigravity-oauth-token"));
    write(join(run, "not-a-provider", ".claude", "projects", "p", "x.jsonl"));
    write(
      join(root, "data", "sandbox", "scratch", "claude", ".claude", "projects", "p", "y.jsonl"),
    );
    write(join(completionProject(root), "chat.jsonl"));
    write(join(root, "data", "completion-sessions", "stray.json"));

    const report = await diagnose(root);
    assert.equal(report.by_provider.claude.session_count, 3);
    assert.equal(report.by_provider.codex.session_count, 1);
    assert.equal(report.by_provider.cursor.session_count, 1);
    assert.equal(report.by_provider.copilot.session_count, 1);
    assert.equal(report.by_provider.antigravity.session_count, 1);
    assert.equal(report.session_count, 7);
    // Disk usage covers each provider home in full (plus the completion project), never unrelated directories.
    assert.equal(report.file_count, 12);
    assert.equal(report.by_provider.codex.file_count, 3);
  }),
);

test(
  "symbolic links are never followed during discovery or scanning",
  withRoot(async (root) => {
    const outside = join(root, "outside");
    write(join(outside, ".claude", "projects", "p", "leak.jsonl"), "z".repeat(5000));
    const sandbox = join(root, "data", "sandbox");
    const home = join(sandbox, "run-1", "claude");
    write(join(home, ".claude", "projects", "p", "real.jsonl"));
    mkdirSync(join(sandbox, "run-1", "codex", ".codex"), { recursive: true });
    symlinkSync(join(outside, ".claude"), join(sandbox, "run-1", "codex", ".codex", "sessions"));
    symlinkSync(outside, join(sandbox, "run-1", "cursor"));
    symlinkSync(join(outside), join(sandbox, "run-2"));
    symlinkSync(join(outside, ".claude", "projects", "p"), join(home, ".claude", "projects", "q"));
    symlinkSync(
      join(outside, ".claude", "projects", "p", "leak.jsonl"),
      join(home, ".claude", "projects", "p", "linked.jsonl"),
    );
    symlinkSync(join(home, ".claude"), join(home, ".claude", "loop"));

    const report = await diagnose(root);
    assert.equal(report.session_count, 1);
    assert.equal(report.file_count, 1);
    assert.equal(report.logical_bytes, 1);
    assert.equal(
      report.scanned_directories.find((d) => d.path === join(sandbox, "run-1", "cursor"))?.status,
      "symlink",
    );
    assert.equal(report.by_provider.cursor.available, false);

    rmSync(sandbox, { recursive: true });
    symlinkSync(outside, sandbox);
    const linked = await diagnose(root);
    assert.equal(linked.scanned_directories.find((d) => d.path === sandbox)?.status, "symlink");
    assert.equal(linked.session_count, 0);
    assert.equal(linked.file_count, 0);
  }),
);

test(
  "a session or file reachable through two paths is counted once",
  withRoot(async (root) => {
    const projects = join(root, "data", "sandbox", "run-3", "claude", ".claude", "projects");
    const original = write(join(projects, "a", "s.jsonl"), "y".repeat(100));
    mkdirSync(join(projects, "b"));
    linkSync(original, join(projects, "b", "s.jsonl"));

    const report = await diagnose(root);
    assert.equal(report.session_count, 1);
    assert.equal(report.file_count, 1);
    assert.equal(report.logical_bytes, 100);
  }),
);

test(
  "logical size and allocated disk usage are reported separately",
  withRoot(async (root) => {
    const sparse = write(join(completionProject(root), "sparse.jsonl"), "");
    truncateSync(sparse, 64 * 1024 * 1024);

    const report = await diagnose(root);
    assert.equal(report.logical_bytes, 64 * 1024 * 1024);
    assert.equal(report.disk_usage_bytes, statSync(sparse).blocks * 512);
    assert.ok(report.disk_usage_bytes < report.logical_bytes);
    assert.equal(report.by_provider.claude.disk_usage_bytes, report.disk_usage_bytes);
  }),
);

test(
  "file age distribution uses the reference time",
  withRoot(async (root) => {
    const now = 1_700_000_000_000;
    const ages = [2 / 24, 4, 14, 60, 150];
    for (const [i, days] of ages.entries()) {
      const f = write(join(completionProject(root), `${i}.jsonl`));
      const t = new Date(now - days * DAY);
      utimesSync(f, t, t);
    }

    const dist = (await diagnose(root, now)).file_age_distribution;
    for (const k of ["under_24h", "1d_to_7d", "7d_to_30d", "30d_to_90d", "over_90d"] as const)
      assert.equal(dist[k].count, 1, k);
    assert.equal(dist.oldest_file_timestamp, new Date(now - 150 * DAY).toISOString());
    assert.equal(dist.newest_file_timestamp, new Date(now - 2 * 3600_000).toISOString());
  }),
);

test(
  "unreadable provider homes are reported, not thrown",
  { skip: process.getuid?.() === 0 },
  withRoot(async (root) => {
    const home = join(root, "data", "sandbox", "run-4", "claude");
    write(join(home, ".claude", "projects", "p", "s.jsonl"));
    chmodSync(home, 0o000);
    try {
      const report = await diagnose(root);
      assert.equal(
        report.scanned_directories.find((d) => d.path === home)?.status,
        "permission_denied",
      );
      assert.ok(report.warnings.some((w) => w.startsWith(home)));
      assert.equal(report.session_count, 0);
    } finally {
      chmodSync(home, 0o700);
    }
  }),
);

test(
  "reads metadata only: no contents in the report, files unchanged",
  withRoot(async (root) => {
    const secret = "CLAUDE_CODE_OAUTH_TOKEN=oauth_super_secret_string";
    const f = write(join(completionProject(root), "s.jsonl"), secret);
    const before = statSync(f);

    const report = await diagnose(root);
    assert.equal(JSON.stringify(report).includes(secret), false);
    const after = statSync(f);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  }),
);

test("route: only the admin path is registered and it requires an admin", async () => {
  const { routes } = await import("../src/api/routes.ts");
  const find = (path: string) => routes.find(([m, re]) => m === "GET" && re.test(path));
  assert.equal(find("/api/session-storage"), undefined);
  assert.equal(find("/api/admin/session-storage/diagnostics"), undefined);
  const route = find("/api/admin/agent-session-storage");
  assert.ok(route);

  const ctx = (role: "admin" | "member") =>
    ({
      actor: { id: 1, role },
      url: new URL("http://localhost/api/admin/agent-session-storage"),
      p: [],
      body: {},
    }) as unknown as Ctx;
  await assert.rejects(async () => route[2](ctx("member")), { status: 403 });
  const report = (await route[2](ctx("admin"))) as Awaited<
    ReturnType<typeof agentSessionStorageDiagnostics>
  >;
  assert.equal(typeof report.session_count, "number");
  assert.ok(report.by_provider.claude);
});
