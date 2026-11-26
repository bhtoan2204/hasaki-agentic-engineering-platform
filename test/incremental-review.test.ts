import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  incrementalCheckpoint,
  incrementalReviewBrief,
  repairDiff,
} from "../src/agent/independentReview.ts";

const finding = {
  severity: "high" as const,
  file: "a.ts",
  line: 3,
  explanation: "null deref",
  evidence: "x.y",
};
const fail = (over: Record<string, unknown> = {}) => ({
  id: 7,
  output: {
    verdict: "FAIL",
    independent: true,
    findings: [finding],
    summary: "one bug",
    verified_heads: { svc: "aaa" },
    verified_base_tips: { svc: "base1" },
    ...over,
  },
});

test("incrementalCheckpoint resumes from a FAIL on the same repositories and base", () => {
  const cp = incrementalCheckpoint(fail(), { svc: "bbb" }, { svc: "base1" });
  assert.deepEqual(cp, {
    attemptId: 7,
    heads: { svc: "aaa" },
    findings: [finding],
    summary: "one bug",
  });
});

test("incrementalCheckpoint falls back to a full review when the checkpoint does not apply", () => {
  assert.equal(incrementalCheckpoint(null, { svc: "b" }, { svc: "base1" }), null);
  assert.equal(
    incrementalCheckpoint(fail({ verdict: "PASS" }), { svc: "b" }, { svc: "base1" }),
    null,
  );
  assert.equal(incrementalCheckpoint(fail(), { svc: "b" }, { svc: "base2" }), null, "base moved");
  assert.equal(
    incrementalCheckpoint(fail(), { svc: "b", other: "c" }, { svc: "base1", other: "x" }),
    null,
    "repo added",
  );
  assert.equal(
    incrementalCheckpoint(fail({ verified_base_tips: undefined }), { svc: "b" }, { svc: "base1" }),
    null,
  );
});

test("incrementalReviewBrief lists the previous findings", () => {
  const brief = incrementalReviewBrief({ attemptId: 7, findings: [finding], summary: "one bug" });
  assert.match(brief, /INCREMENTAL RE-REVIEW/);
  assert.match(brief, /1\. \[high\] a\.ts:3 — null deref\n {3}evidence: x\.y/);
});

test("repairDiff shows only commits after the checkpoint and refuses rewritten history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "incr-review-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        encoding: "utf8",
      }).trim();
    git("init", "-q");
    writeFileSync(join(dir, "a.ts"), "original\n");
    git("add", ".");
    git("commit", "-qm", "impl");
    const checkpoint = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "a.ts"), "repaired\n");
    git("commit", "-qam", "repair");
    const diff = await repairDiff([{ repo: "svc", path: dir }], { svc: checkpoint });
    assert.ok(diff);
    assert.match(diff, /-original\n\+repaired/);

    git("reset", "-q", "--hard", checkpoint);
    git("commit", "-q", "--amend", "-m", "rewritten");
    assert.equal(await repairDiff([{ repo: "svc", path: dir }], { svc: checkpoint }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
