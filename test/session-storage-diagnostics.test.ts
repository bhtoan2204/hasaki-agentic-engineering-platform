import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  agentSessionStorageDiagnostics,
  sessionStorageDiagnostics,
  formatBytes,
  emptyAgeDistribution,
  recordFileInAgeDistribution,
  mergeAgeDistributions,
} from "../src/agent/sessionDiagnostics.ts";

function createTempDir(prefix = "ctp-session-diag-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("formatBytes: converts byte counts to human-readable strings", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(-10), "0 B");
  assert.equal(formatBytes(500), "500 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(10 * 1024 * 1024), "10.0 MB");
  assert.equal(formatBytes(1.5 * 1024 * 1024 * 1024), "1.5 GB");
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024 * 1024), "2.0 TB");
});

test("ageDistribution helpers: emptyAgeDistribution, recordFileInAgeDistribution, mergeAgeDistributions", () => {
  const dist = emptyAgeDistribution();
  assert.equal(dist.total_files, 0);
  assert.equal(dist.total_bytes, 0);
  assert.equal(dist.oldest_file_age_days, null);
  assert.equal(dist.newest_file_age_days, null);
  assert.equal(dist.under_24h.count, 0);
  assert.equal(dist.buckets["< 1 day"].count, 0);

  const now = 1_700_000_000_000;
  // 1 hour old (< 1 day)
  recordFileInAgeDistribution(dist, 100, now - 3600_000, now);
  // 2 days old (1d to 7d)
  recordFileInAgeDistribution(dist, 200, now - 2 * 86400_000, now);

  assert.equal(dist.total_files, 2);
  assert.equal(dist.total_bytes, 300);
  assert.equal(dist.under_24h.count, 1);
  assert.equal(dist.under_24h.bytes, 100);
  assert.equal(dist["1d_to_7d"].count, 1);
  assert.equal(dist["1d_to_7d"].bytes, 200);

  const dist2 = emptyAgeDistribution();
  // 100 days old (> 90 days)
  recordFileInAgeDistribution(dist2, 500, now - 100 * 86400_000, now);
  mergeAgeDistributions(dist, dist2);

  assert.equal(dist.total_files, 3);
  assert.equal(dist.total_bytes, 800);
  assert.equal(dist.over_90d.count, 1);
  assert.equal(dist.over_90d.bytes, 500);
  assert.equal(dist.buckets["> 90 days"].count, 1);
  assert.ok(dist.oldest_file_age_days! >= 100);
});

test("diagnostics on missing directory handles missing paths safely without throwing", async () => {
  const nonExistentDir = join(tmpdir(), "non-existent-session-dir-" + Date.now());
  const report = await agentSessionStorageDiagnostics({
    dataDir: nonExistentDir,
    includeDatabase: false,
  });

  assert.equal(report.session_count, 0);
  assert.equal(report.total_disk_usage_bytes, 0);
  assert.equal(report.total_files, 0);
  assert.equal(report.total_disk_usage, "0 B");
  assert.ok(report.timestamp);

  // All known providers should exist in by_provider with available: false
  for (const p of ["claude", "cursor", "codex", "antigravity", "copilot"]) {
    const prov = report.by_provider[p];
    assert.ok(prov, `Provider ${p} missing in report.by_provider`);
    assert.equal(prov.available, false);
    assert.equal(prov.session_count, 0);
    assert.equal(prov.file_count, 0);
    assert.equal(prov.disk_usage_bytes, 0);
  }

  // Scanned directories should record completion-sessions as missing
  const completionScan = report.scanned_directories.find((d) =>
    d.path.endsWith("completion-sessions"),
  );
  assert.ok(completionScan);
  assert.equal(completionScan.exists, false);
  assert.equal(completionScan.status, "missing");
});

test("diagnostics on empty session directory reports zeroes safely", async () => {
  const root = createTempDir("session-empty-");
  try {
    mkdirSync(join(root, "completion-sessions"));
    mkdirSync(join(root, "sandbox"));

    const report = await sessionStorageDiagnostics({
      dataDir: root,
      includeDatabase: false,
    });

    assert.equal(report.session_count, 0);
    assert.equal(report.total_disk_usage_bytes, 0);
    assert.equal(report.total_files, 0);
    assert.equal(report.total_disk_usage, "0 B");
    assert.equal(report.file_age_distribution.total_files, 0);
    assert.equal(report.by_provider.claude.session_count, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostics counts sessions, calculates disk usage and attributes by provider", async () => {
  const root = createTempDir("session-usage-");
  try {
    // 1. Completion sessions (Claude)
    const completionDir = join(root, "completion-sessions");
    mkdirSync(completionDir, { recursive: true });
    writeFileSync(join(completionDir, "session-c1.json"), "a".repeat(1200));
    writeFileSync(join(completionDir, "session-c2.json"), "b".repeat(800));

    // 2. Sandbox runs: run-101 has Claude and Codex
    const run101Claude = join(root, "sandbox", "run-101", "claude");
    mkdirSync(run101Claude, { recursive: true });
    writeFileSync(join(run101Claude, "claude-state.json"), "c".repeat(500));

    const run101Codex = join(root, "sandbox", "run-101", "codex");
    mkdirSync(run101Codex, { recursive: true });
    writeFileSync(join(run101Codex, "codex-thread.json"), "d".repeat(1000));
    writeFileSync(join(run101Codex, "log.txt"), "d".repeat(200));

    // 3. Provider folder under dataDir: cursor
    const cursorDir = join(root, "cursor", "sess-cur-1");
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, "transcript.json"), "e".repeat(1500));

    const report = await agentSessionStorageDiagnostics({
      dataDir: root,
      includeDatabase: false,
    });

    // Sessions:
    // - completion-sessions: 2 sessions (session-c1.json, session-c2.json)
    // - sandbox run-101 claude: 1 session
    // - sandbox run-101 codex: 1 session
    // - cursor: 1 session (sess-cur-1)
    // Total sessions = 5
    assert.equal(report.session_count, 5);

    // Files: 2 (completion) + 1 (run101 claude) + 2 (run101 codex) + 1 (cursor) = 6
    assert.equal(report.total_files, 6);

    // Bytes: 1200 + 800 + 500 + 1000 + 200 + 1500 = 5200 bytes
    assert.equal(report.total_disk_usage_bytes, 5200);
    assert.equal(report.total_disk_usage, formatBytes(5200));

    // Provider breakdown
    // Claude: 2 completion + 1 sandbox = 3 sessions, 3 files, 2500 bytes
    const claudeUsage = report.by_provider.claude;
    assert.equal(claudeUsage.available, true);
    assert.equal(claudeUsage.session_count, 3);
    assert.equal(claudeUsage.file_count, 3);
    assert.equal(claudeUsage.disk_usage_bytes, 2500);
    assert.equal(claudeUsage.disk_usage_human, formatBytes(2500));

    // Codex: 1 sandbox session, 2 files, 1200 bytes
    const codexUsage = report.by_provider.codex;
    assert.equal(codexUsage.available, true);
    assert.equal(codexUsage.session_count, 1);
    assert.equal(codexUsage.file_count, 2);
    assert.equal(codexUsage.disk_usage_bytes, 1200);

    // Cursor: 1 session, 1 file, 1500 bytes
    const cursorUsage = report.by_provider.cursor;
    assert.equal(cursorUsage.available, true);
    assert.equal(cursorUsage.session_count, 1);
    assert.equal(cursorUsage.file_count, 1);
    assert.equal(cursorUsage.disk_usage_bytes, 1500);

    // Antigravity & Copilot: 0 sessions, available: false
    assert.equal(report.by_provider.antigravity.available, false);
    assert.equal(report.by_provider.antigravity.session_count, 0);
    assert.equal(report.by_provider.copilot.available, false);
    assert.equal(report.by_provider.copilot.session_count, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostics file age distribution partitions files into all 5 standardized buckets", async () => {
  const root = createTempDir("session-age-");
  try {
    const sessDir = join(root, "completion-sessions");
    mkdirSync(sessDir, { recursive: true });

    const now = 1_700_000_000_000; // Fixed reference timestamp
    const dayMs = 24 * 60 * 60 * 1000;

    // 1. Under 24h: modified 2 hours ago
    const f1 = join(sessDir, "under-24h.json");
    writeFileSync(f1, "1".repeat(100));
    const t1 = new Date(now - 2 * 3600_000);
    utimesSync(f1, t1, t1);

    // 2. 1d to 7d: modified 4 days ago
    const f2 = join(sessDir, "1d-7d.json");
    writeFileSync(f2, "2".repeat(200));
    const t2 = new Date(now - 4 * dayMs);
    utimesSync(f2, t2, t2);

    // 3. 7d to 30d: modified 14 days ago
    const f3 = join(sessDir, "7d-30d.json");
    writeFileSync(f3, "3".repeat(300));
    const t3 = new Date(now - 14 * dayMs);
    utimesSync(f3, t3, t3);

    // 4. 30d to 90d: modified 60 days ago
    const f4 = join(sessDir, "30d-90d.json");
    writeFileSync(f4, "4".repeat(400));
    const t4 = new Date(now - 60 * dayMs);
    utimesSync(f4, t4, t4);

    // 5. Over 90d: modified 150 days ago
    const f5 = join(sessDir, "over-90d.json");
    writeFileSync(f5, "5".repeat(500));
    const t5 = new Date(now - 150 * dayMs);
    utimesSync(f5, t5, t5);

    const report = await agentSessionStorageDiagnostics({
      dataDir: root,
      now,
      includeDatabase: false,
    });

    const dist = report.file_age_distribution;
    assert.equal(dist.total_files, 5);
    assert.equal(dist.total_bytes, 1500);

    // Bucket 1: under_24h (< 1 day)
    assert.equal(dist.under_24h.count, 1);
    assert.equal(dist.under_24h.bytes, 100);
    assert.equal(dist.buckets["< 1 day"].count, 1);
    assert.equal(dist.buckets["< 1 day"].bytes, 100);

    // Bucket 2: 1d_to_7d (1-7 days)
    assert.equal(dist["1d_to_7d"].count, 1);
    assert.equal(dist["1d_to_7d"].bytes, 200);
    assert.equal(dist.buckets["1-7 days"].count, 1);
    assert.equal(dist.buckets["1-7 days"].bytes, 200);

    // Bucket 3: 7d_to_30d (7-30 days)
    assert.equal(dist["7d_to_30d"].count, 1);
    assert.equal(dist["7d_to_30d"].bytes, 300);
    assert.equal(dist.buckets["7-30 days"].count, 1);
    assert.equal(dist.buckets["7-30 days"].bytes, 300);

    // Bucket 4: 30d_to_90d (30-90 days)
    assert.equal(dist["30d_to_90d"].count, 1);
    assert.equal(dist["30d_to_90d"].bytes, 400);
    assert.equal(dist.buckets["30-90 days"].count, 1);
    assert.equal(dist.buckets["30-90 days"].bytes, 400);

    // Bucket 5: over_90d (> 90 days)
    assert.equal(dist.over_90d.count, 1);
    assert.equal(dist.over_90d.bytes, 500);
    assert.equal(dist.buckets["> 90 days"].count, 1);
    assert.equal(dist.buckets["> 90 days"].bytes, 500);

    // Oldest and newest file age stats
    assert.ok(dist.oldest_file_age_days! >= 149);
    assert.ok(dist.newest_file_age_days! <= 1);
    assert.equal(dist.oldest_file_timestamp, t5.toISOString());
    assert.equal(dist.newest_file_timestamp, t1.toISOString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("symbolic links: handles file symlinks, cyclic directory symlinks and broken symlinks safely", async () => {
  const root = createTempDir("session-symlink-");
  try {
    const compDir = join(root, "completion-sessions");
    mkdirSync(compDir, { recursive: true });

    // 1. Regular file
    const realFile = join(compDir, "real-session.json");
    writeFileSync(realFile, "real data 12345");

    // 2. Symlink to file
    const symlinkFile = join(compDir, "symlink-session.json");
    symlinkSync(realFile, symlinkFile);

    // 3. Broken symlink (target does not exist)
    const brokenSymlink = join(compDir, "broken-link.json");
    symlinkSync(join(compDir, "missing-target.json"), brokenSymlink);

    // 4. Circular directory symlink (symlink pointing to parent or self)
    const subDir = join(compDir, "nested-session");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "inner.json"), "inner content");
    // Cyclic link: nested-session/loop -> nested-session
    const cyclicLink = join(subDir, "loop");
    symlinkSync(subDir, cyclicLink);

    // Diagnostics must complete safely without hanging, infinite recursion, or throwing
    const report = await agentSessionStorageDiagnostics({
      dataDir: root,
      includeDatabase: false,
    });

    assert.ok(report.session_count > 0);
    assert.ok(report.total_disk_usage_bytes > 0);
    assert.ok(report.total_files >= 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("permission errors: handles unreadable directories safely without crashing", async () => {
  const root = createTempDir("session-perm-");
  try {
    const compDir = join(root, "completion-sessions");
    mkdirSync(compDir, { recursive: true });
    writeFileSync(join(compDir, "accessible.json"), "hello");

    const restrictedDir = join(root, "sandbox", "run-secret", "claude");
    mkdirSync(restrictedDir, { recursive: true });
    writeFileSync(join(restrictedDir, "restricted.json"), "secret");

    // Make restrictedDir unreadable (chmod 000)
    try {
      chmodSync(restrictedDir, 0o000);
    } catch {
      // Some platforms/filesystems may not support chmod 000
    }

    const report = await agentSessionStorageDiagnostics({
      dataDir: root,
      includeDatabase: false,
    });

    // Should complete successfully without throwing
    assert.ok(report.session_count >= 1);
    assert.ok(report.total_files >= 1);

    // Check if permission denial was noted in scanned_directories or warnings
    const restrictedScan = report.scanned_directories.find((d) => d.path === restrictedDir);
    if (restrictedScan && restrictedScan.status === "permission_denied") {
      assert.equal(restrictedScan.exists, true);
      assert.equal(restrictedScan.status, "permission_denied");
      assert.ok(report.warnings.some((w) => w.includes("Permission denied")));
    }
  } finally {
    // Restore permissions so rmSync can clean up
    try {
      chmodSync(join(root, "sandbox", "run-secret", "claude"), 0o755);
    } catch {
      // ignore
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("credential and content privacy: never exposes file contents or credentials in diagnostics output", async () => {
  const root = createTempDir("session-privacy-");
  try {
    const compDir = join(root, "completion-sessions");
    mkdirSync(compDir, { recursive: true });

    const sensitiveApiKey = "AI_SECRET_KEY_987654321_DO_NOT_LEAK";
    const sensitivePrompt = "SECRET_PROMPT: Please optimize the payment gateway credentials";
    const sensitiveOauthToken = "CLAUDE_CODE_OAUTH_TOKEN=oauth_super_secret_string";

    writeFileSync(
      join(compDir, "session-secret-1.json"),
      JSON.stringify({
        apiKey: sensitiveApiKey,
        prompt: sensitivePrompt,
        env: { TOKEN: sensitiveOauthToken },
        messages: [{ role: "user", content: "Top secret session chat content" }],
      }),
    );

    const report = await agentSessionStorageDiagnostics({
      dataDir: root,
      includeDatabase: false,
    });

    const serialized = JSON.stringify(report);

    // Verify none of the sensitive values or user contents appear in the report
    assert.equal(serialized.includes(sensitiveApiKey), false, "Leaked sensitive API key!");
    assert.equal(serialized.includes(sensitivePrompt), false, "Leaked sensitive prompt!");
    assert.equal(serialized.includes(sensitiveOauthToken), false, "Leaked OAuth token!");
    assert.equal(
      serialized.includes("Top secret session chat content"),
      false,
      "Leaked chat session message content!",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read-only guarantee: does not delete, truncate, or alter session files or lifecycle", async () => {
  const root = createTempDir("session-readonly-");
  try {
    const compDir = join(root, "completion-sessions");
    mkdirSync(compDir, { recursive: true });

    const file1 = join(compDir, "test-session-1.json");
    const file2 = join(compDir, "test-session-2.json");
    const content1 = "Initial session data content 1";
    const content2 = "Initial session data content 2";
    writeFileSync(file1, content1);
    writeFileSync(file2, content2);

    const stat1Before = statSync(file1);
    const stat2Before = statSync(file2);

    // Run diagnostics
    const report = await agentSessionStorageDiagnostics({
      dataDir: root,
      includeDatabase: false,
    });

    assert.equal(report.session_count, 2);
    assert.equal(report.total_files, 2);

    // Verify files still exist with exact same sizes and modification times
    const stat1After = statSync(file1);
    const stat2After = statSync(file2);

    assert.equal(stat1After.size, stat1Before.size);
    assert.equal(stat1After.mtimeMs, stat1Before.mtimeMs);
    assert.equal(stat2After.size, stat2Before.size);
    assert.equal(stat2After.mtimeMs, stat2Before.mtimeMs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("custom options: sessionDir and providerDirs overrides", async () => {
  const root = createTempDir("session-custom-");
  try {
    const customSessionDir = join(root, "custom-sessions");
    mkdirSync(customSessionDir, { recursive: true });
    writeFileSync(join(customSessionDir, "sess-1.txt"), "hello 1");
    writeFileSync(join(customSessionDir, "sess-2.txt"), "hello 22");

    const customCodexDir = join(root, "codex-storage");
    mkdirSync(customCodexDir, { recursive: true });
    writeFileSync(join(customCodexDir, "thread-1.json"), "codex thread");

    const report = await agentSessionStorageDiagnostics({
      dataDir: root,
      sessionDir: customSessionDir,
      providerDirs: {
        codex: customCodexDir,
      },
      includeDatabase: false,
    });

    assert.equal(report.session_count, 3); // 2 in customSessionDir + 1 in customCodexDir
    assert.equal(report.by_provider.codex.session_count, 1);
    assert.equal(report.by_provider.codex.available, true);
    assert.ok(report.by_provider.codex.directories.includes(customCodexDir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("module re-export: src/agent/sessionStorage re-exports agentSessionStorageDiagnostics and helpers", async () => {
  const mod = await import("../src/agent/sessionStorage.ts");
  assert.equal(typeof mod.agentSessionStorageDiagnostics, "function");
  assert.equal(typeof mod.sessionStorageDiagnostics, "function");
  assert.equal(typeof mod.formatBytes, "function");
  assert.equal(typeof mod.emptyAgeDistribution, "function");
});

test("HTTP route: /api/admin/agent-session-storage is registered and enforces admin authorization", async () => {
  const { routes } = await import("../src/api/routes.ts");

  // Verify matching routes for admin endpoints
  const matched1 = routes.find(
    ([method, re]) => method === "GET" && re.test("/api/admin/agent-session-storage"),
  );
  assert.ok(matched1, "Route /api/admin/agent-session-storage not found");

  const matched2 = routes.find(
    ([method, re]) => method === "GET" && re.test("/api/admin/session-storage"),
  );
  assert.ok(matched2, "Route /api/admin/session-storage not found");

  const handler = matched1[2];

  // 1. Calling handler with member actor -> throws 403 admin only
  const memberActor = { id: 10, role: "member" as const };
  await assert.rejects(
    async () => {
      await handler({
        actor: memberActor,
        url: new URL("http://localhost/api/admin/agent-session-storage"),
        p: [],
        body: null,
      } as any);
    },
    (err: any) => err.status === 403 && err.message === "admin only",
  );

  // 2. Calling handler with admin actor -> returns diagnostic report
  const adminActor = { id: 1, role: "admin" as const };
  const res: any = await handler({
    actor: adminActor,
    url: new URL("http://localhost/api/admin/agent-session-storage"),
    p: [],
    body: null,
  } as any);

  assert.ok(res);
  assert.equal(typeof res.session_count, "number");
  assert.equal(typeof res.total_disk_usage_bytes, "number");
  assert.ok(res.file_age_distribution);
  assert.ok(res.by_provider);
  assert.ok(res.timestamp);
});
