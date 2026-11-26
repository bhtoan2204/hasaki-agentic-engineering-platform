import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_THRESHOLDS,
  autoRestorable,
  chatContradicted,
  decide,
  disuse,
  kindOf,
  lessonContradicted,
  lessonDisputed,
  overCap,
  polarity,
  procedureFailed,
  purge,
  replacement,
  stale,
  thresholdsFrom,
  unapproved,
  unknown,
  unknownIsPermanent,
  type AgingItem,
} from "../src/knowledge/agingPolicy.ts";

const NOW = new Date("2026-06-01T00:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const TH = DEFAULT_THRESHOLDS;
let seq = 0;
function item(over: Partial<AgingItem> & { memory?: Record<string, unknown> } = {}): AgingItem {
  const id = ++seq;
  return {
    id,
    key: `memory.run-${id}.svc.facts`,
    ownerId: 1,
    repo: "svc",
    kind: "facts",
    enabled: true,
    currentVersion: 1,
    createdAt: ago(500),
    updatedAt: ago(10),
    trust: "verified",
    state: "active",
    pinned: false,
    stateAt: null,
    policy: null,
    unknownSince: null,
    unknownCode: null,
    lastLoadedAt: null,
    ...over,
    memory: {
      run_id: id,
      files: ["a.go"],
      extracted_at: ago(10).toISOString(),
      ...(over.memory ?? {}),
    },
  };
}

test("kindOf recognises run memory, lessons and the two kinds of chat memory; curated keys are none of its business", () => {
  assert.equal(kindOf("memory.run-12.svc.facts", {}), "facts");
  assert.equal(kindOf("memory.run-12.svc.conclusions", {}), "conclusions");
  assert.equal(kindOf("memory.lesson.negative.svc.abcd", {}), "lesson");
  assert.equal(kindOf("memory.chat.abc", { kind: "procedure" }), "chat_procedure");
  assert.equal(kindOf("memory.chat.abc", { kind: "preference" }), "chat_preference");
  assert.equal(kindOf("business.refund-window", {}), null);
});

test("thresholds: documented defaults, blanks and invalid values fall back, purge 0 means never", () => {
  assert.deepEqual(thresholdsFrom({}), TH);
  assert.equal(thresholdsFrom({ unknownDays: "7" }).unknownDays, 7);
  assert.equal(thresholdsFrom({ unknownDays: "" }).unknownDays, 14);
  assert.equal(thresholdsFrom({ unknownDays: "abc" }).unknownDays, 14);
  assert.equal(
    thresholdsFrom({ unknownDays: "0" }).unknownDays,
    14,
    "0 days would archive everything at once",
  );
  assert.equal(thresholdsFrom({ purgeDays: "0" }).purgeDays, 0);
});

// ---- 1 replacement
test("1 replacement: a newer verified memory covering all files supersedes the older one", () => {
  const older = item({ memory: { files: ["a.go", "b.go"], extracted_at: ago(20).toISOString() } });
  const newer = item({
    memory: { files: ["a.go", "b.go", "c.go"], extracted_at: ago(5).toISOString(), run_id: 99 },
  });
  const d = replacement(older, [older, newer]);
  assert.equal(d?.action, "supersede");
  assert.equal(d?.replacedBy, newer.key);
  assert.equal(
    replacement(newer, [older, newer]),
    null,
    "the newer one is not replaced by the older",
  );
});

test("1 replacement: partial coverage, another owner or repo, another kind, or an untrusted successor do not replace", () => {
  const older = item({ memory: { files: ["a.go", "b.go"], extracted_at: ago(20).toISOString() } });
  const mk = (over: Partial<AgingItem>) =>
    item({ memory: { files: ["a.go", "b.go"], extracted_at: ago(5).toISOString() }, ...over });
  assert.equal(
    replacement(older, [
      older,
      mk({ memory: { files: ["a.go"], extracted_at: ago(5).toISOString() } }),
    ]),
    null,
  );
  assert.equal(replacement(older, [older, mk({ ownerId: 2 })]), null);
  assert.equal(replacement(older, [older, mk({ repo: "other" })]), null);
  assert.equal(replacement(older, [older, mk({ kind: "conclusions", trust: "approved" })]), null);
  assert.equal(replacement(older, [older, mk({ trust: "unverified" })]), null);
  assert.equal(
    replacement(item({ memory: { files: [] } }), [older]),
    null,
    "no files: nothing to compare",
  );
  assert.equal(
    replacement(
      item({ pinned: true, memory: { files: ["a.go"], extracted_at: ago(20).toISOString() } }),
      [mk({})],
    ),
    null,
  );
});

// ---- 2 stale
test("2 stale: STALE archives with the reason; FRESH and UNKNOWN do not", () => {
  const i = item();
  assert.deepEqual(
    stale(i, { state: "STALE", reason: "changed on origin/main since the task: a.go" }),
    {
      action: "archive",
      policy: "stale",
      reason: "changed on origin/main since the task: a.go",
    },
  );
  assert.equal(stale(i, { state: "FRESH", reason: "" }), null);
  assert.equal(stale(i, { state: "UNKNOWN", reason: "" }), null);
  assert.equal(
    stale(item({ pinned: true }), { state: "STALE", reason: "x" }),
    null,
    "a restored item stays",
  );
});

// ---- 3 unknown
test("3 unknown: only reasons that cannot recover are permanent; commit_missing only on the run's own instance", () => {
  for (const code of ["no_provenance", "no_commit", "no_file_list", "repo_unregistered"] as const)
    assert.equal(unknownIsPermanent(code, false), true, code);
  for (const code of ["repo_missing", "base_missing", "fetch_old", "git_error"] as const)
    assert.equal(unknownIsPermanent(code, true), false, code);
  assert.equal(unknownIsPermanent("commit_missing", true), true);
  assert.equal(
    unknownIsPermanent("commit_missing", false),
    false,
    "another instance's clone never had the commit",
  );
  assert.equal(
    unknownIsPermanent("commit_missing", null),
    false,
    "legacy run without a worker instance",
  );
});

test("3 unknown: archived after N days of a permanent reason; a transient one never counts and clears the clock", () => {
  const th = { unknownDays: 14 };
  const first = unknown(item(), { code: "no_commit", permanent: true }, NOW, th);
  assert.equal(first.since?.getTime(), NOW.getTime(), "the clock starts at the first sighting");
  assert.equal(first.decision, null);
  const young = unknown(
    item({ unknownSince: ago(13) }),
    { code: "no_commit", permanent: true },
    NOW,
    th,
  );
  assert.equal(young.decision, null);
  const old = unknown(
    item({ unknownSince: ago(14) }),
    { code: "no_commit", permanent: true },
    NOW,
    th,
  );
  assert.equal(old.decision?.policy, "unknown");
  assert.match(old.decision!.reason, /no_commit.*14 days/);
  const transient = unknown(
    item({ unknownSince: ago(100) }),
    { code: "fetch_old", permanent: false },
    NOW,
    th,
  );
  assert.equal(transient.decision, null, "an old fetch is not evidence");
  assert.equal(transient.since, null, "and it clears a running clock");
  const resolved = unknown(item({ unknownSince: ago(100) }), null, NOW, th);
  assert.equal(resolved.since, null);
  assert.equal(
    unknown(
      item({ pinned: true, unknownSince: ago(100) }),
      { code: "no_commit", permanent: true },
      NOW,
      th,
    ).decision,
    null,
  );
});

// ---- 4 unapproved
test("4 unapproved: conclusions still unapproved or rejected after 30 days are archived; approved ones and younger ones are not", () => {
  const mk = (trust: string, days: number) =>
    item({
      kind: "conclusions",
      trust,
      enabled: false,
      memory: { extracted_at: ago(days).toISOString() },
    });
  assert.equal(unapproved(mk("unverified", 30), NOW, TH)?.policy, "unapproved");
  assert.equal(unapproved(mk("rejected", 45), NOW, TH)?.action, "archive");
  assert.equal(unapproved(mk("unverified", 29), NOW, TH), null);
  assert.equal(unapproved(mk("approved", 400), NOW, TH), null);
  assert.equal(
    unapproved(item({ trust: "unverified" }), NOW, TH),
    null,
    "facts are not conclusions",
  );
});

// ---- 5 disuse
test("5 disuse: dormant after the first window, archived after the second; counted from the last load", () => {
  assert.equal(disuse(item({ lastLoadedAt: ago(59) }), NOW, TH), null);
  assert.equal(disuse(item({ lastLoadedAt: ago(60) }), NOW, TH)?.action, "dormant");
  assert.equal(disuse(item({ lastLoadedAt: ago(119) }), NOW, TH)?.action, "dormant");
  assert.equal(disuse(item({ lastLoadedAt: ago(120) }), NOW, TH)?.action, "archive");
  assert.equal(
    disuse(item({ createdAt: ago(130) }), NOW, TH)?.action,
    "archive",
    "never loaded: counted from creation",
  );
  assert.equal(
    disuse(item({ createdAt: ago(130), lastLoadedAt: ago(1) }), NOW, TH),
    null,
    "a recent load resets it",
  );
  assert.equal(
    disuse(item({ state: "dormant", lastLoadedAt: ago(70) }), NOW, TH),
    null,
    "already dormant: no repeat",
  );
});

test("5 disuse: human-approved items get the longer window; lessons their own pair", () => {
  const approved = item({ kind: "conclusions", trust: "approved", lastLoadedAt: ago(100) });
  assert.equal(
    disuse(approved, NOW, TH),
    null,
    "100 idle days is past the verified-only window, not the approved one",
  );
  assert.equal(disuse({ ...approved, lastLoadedAt: ago(120) }, NOW, TH)?.action, "dormant");
  assert.equal(disuse({ ...approved, lastLoadedAt: ago(240) }, NOW, TH)?.action, "archive");
  const lesson = item({ kind: "lesson", lastLoadedAt: ago(90) });
  assert.equal(disuse(lesson, NOW, TH)?.action, "dormant");
  assert.equal(disuse({ ...lesson, lastLoadedAt: ago(180) }, NOW, TH)?.action, "archive");
  assert.equal(
    disuse(item({ kind: "chat_procedure", lastLoadedAt: ago(180) }), NOW, TH)?.action,
    "archive",
  );
});

test("5 disuse: preferences and corrections never expire by time; pinned and unapproved items are left alone", () => {
  assert.equal(
    disuse(item({ kind: "chat_preference", trust: "human", createdAt: ago(5000) }), NOW, TH),
    null,
  );
  assert.equal(disuse(item({ pinned: true, createdAt: ago(5000) }), NOW, TH), null);
  assert.equal(
    disuse(
      item({ kind: "conclusions", trust: "unverified", enabled: false, createdAt: ago(5000) }),
      NOW,
      TH,
    ),
    null,
  );
  assert.equal(disuse(item({ enabled: false, createdAt: ago(5000) }), NOW, TH), null);
});

test("5 disuse: an automatically restored item gets a fresh window from its restore", () => {
  const restored = item({
    kind: "chat_procedure",
    state: "restored",
    stateAt: ago(1),
    createdAt: ago(400),
  });
  assert.equal(disuse(restored, NOW, TH), null);
});

// ---- 6 lessons
const lesson = (over: Partial<AgingItem> & { memory?: Record<string, unknown> } = {}) =>
  item({
    kind: "lesson",
    key: `memory.lesson.procedural.svc.${++seq}`,
    memory: {
      purpose: "procedural",
      evidence: { run_id: 7 },
      files: ["a.go"],
      extracted_at: ago(30).toISOString(),
      ...(over.memory ?? {}),
    },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "memory")),
  });
const obs = (over: Partial<Parameters<typeof lessonContradicted>[1][number]> = {}) => ({
  kind: "regression_reported",
  runId: 7,
  repo: "svc",
  observedAt: ago(5),
  files: [] as string[],
  ...over,
});

test("6a lesson contradicted: a report on the lesson's own evidence run archives it", () => {
  assert.equal(lessonContradicted(lesson(), [obs()])?.action, "archive");
  assert.equal(
    lessonContradicted(lesson(), [obs({ kind: "rollback_reported" })])?.policy,
    "lesson_contradicted",
  );
  assert.equal(
    lessonContradicted(lesson(), [obs({ observedAt: ago(40) })]),
    null,
    "a report from before the lesson",
  );
  assert.equal(
    lessonContradicted(lesson(), [obs({ kind: "tests_failed" })]),
    null,
    "tests_failed describes the run itself",
  );
  assert.equal(lessonContradicted(lesson(), [obs({ kind: "pr_closed" })]), null);
  assert.equal(
    lessonContradicted(lesson({ memory: { purpose: "negative" } }), [obs()]),
    null,
    "only procedural lessons",
  );
});

test("6a lesson contradicted: a report on another run that touched the same file only makes it dormant", () => {
  const other = obs({ runId: 8, files: ["a.go", "z.go"] });
  assert.equal(lessonContradicted(lesson(), [other])?.action, "dormant");
  assert.equal(lessonContradicted(lesson({ state: "dormant" }), [other]), null, "already dormant");
  assert.equal(
    lessonContradicted(lesson(), [obs({ runId: 8, files: ["z.go"] })]),
    null,
    "no shared file",
  );
  assert.equal(
    lessonContradicted(lesson(), [obs({ runId: 8, repo: "other", files: ["a.go"] })]),
    null,
    "another repository",
  );
  assert.equal(
    lessonContradicted(lesson(), [other, obs()])?.action,
    "archive",
    "the own-run report wins",
  );
});

test("6b lesson disputed: archived when still disputed after 30 days", () => {
  const disputed = (days: number) =>
    lesson({ updatedAt: ago(days), memory: { status: "disputed" } });
  assert.equal(lessonDisputed(disputed(30), NOW, TH)?.policy, "lesson_disputed");
  assert.equal(lessonDisputed(disputed(29), NOW, TH), null);
  assert.equal(
    lessonDisputed(lesson({ updatedAt: ago(90), memory: { status: "active" } }), NOW, TH),
    null,
  );
});

// ---- 7 chat memory
const pref = (claim: string, daysOld: number, over: Partial<AgingItem> = {}) =>
  item({
    kind: "chat_preference",
    trust: "human",
    createdAt: ago(daysOld),
    memory: { claim },
    key: `memory.chat.${++seq}`,
    ...over,
  });

test("7a polarity: only a leading marker from the closed list counts, and only when the rest is clean", () => {
  assert.deepEqual(polarity("Always use tabs."), { polarity: "affirm", subject: "use tabs" });
  assert.deepEqual(polarity("never use tabs"), { polarity: "negate", subject: "use tabs" });
  assert.deepEqual(polarity("Don't use tabs!"), { polarity: "negate", subject: "use tabs" });
  assert.deepEqual(polarity("luôn dùng tab"), { polarity: "affirm", subject: "dùng tab" });
  assert.deepEqual(polarity("đừng dùng tab"), { polarity: "negate", subject: "dùng tab" });
  assert.deepEqual(polarity("không bao giờ dùng tab"), { polarity: "negate", subject: "dùng tab" });
  assert.equal(polarity("remember that I use tabs"), null, "not a polarity marker");
  assert.equal(polarity("always use tabs, never spaces"), null, "two markers");
  assert.equal(polarity("always do not-this"), null, "a negation inside the subject");
  assert.equal(polarity("không phải tab mà là space"), null, "a correction, not a marker");
  assert.equal(polarity("alwaysuse tabs"), null, "the marker must be a whole word");
  assert.equal(polarity("never"), null, "no subject");
});

test("7a chat contradiction: a newer statement with the identical subject and opposite marker supersedes the older", () => {
  const older = pref("Always use tabs.", 10);
  const newer = pref("Never use tabs", 2);
  const d = chatContradicted(older, [older, newer]);
  assert.equal(d?.action, "supersede");
  assert.equal(d?.replacedBy, newer.key);
  assert.equal(chatContradicted(newer, [older, newer]), null, "the newer one stays");
});

test("7a chat contradiction: anything but an exact subject match is left alone", () => {
  const older = pref("Always use tabs for Go files", 10);
  for (const claim of [
    "Never use tabs",
    "Never use tabs for Go",
    "Never use tabs for Go files in tests",
    "Always use spaces for Go files",
  ])
    assert.equal(chatContradicted(older, [older, pref(claim, 2)]), null, claim);
  assert.equal(
    chatContradicted(older, [older, pref("Never use tabs for Go files", 2, { ownerId: 2 })]),
    null,
    "another owner",
  );
  assert.equal(
    chatContradicted(older, [older, pref("Never use tabs for Go files", 20)]),
    null,
    "an older statement never supersedes",
  );
  assert.equal(
    chatContradicted(older, [older, pref("Always use tabs for Go files", 2)]),
    null,
    "same polarity is a repeat, not a contradiction",
  );
  assert.equal(
    chatContradicted(pref("Remember that I like tabs", 10), [pref("Never like tabs", 2)]),
    null,
    "no polarity",
  );
});

test("7b procedure failed: archived when the latest operation failed after the procedure was last confirmed", () => {
  const proc = item({
    kind: "chat_procedure",
    trust: "verified",
    memory: { last_seen_at: ago(10).toISOString() },
  });
  assert.equal(
    procedureFailed(proc, { status: "failed", finishedAt: ago(2) })?.policy,
    "procedure_failed",
  );
  assert.equal(
    procedureFailed(proc, { status: "failed", finishedAt: ago(20) }),
    null,
    "failed before it was last confirmed",
  );
  assert.equal(procedureFailed(proc, { status: "succeeded", finishedAt: ago(2) }), null);
  assert.equal(procedureFailed(proc, null), null);
  assert.equal(
    procedureFailed(item({ kind: "chat_preference" }), { status: "failed", finishedAt: ago(2) }),
    null,
  );
});

test("7b automatic restore applies only to procedure_failed archives and never to a pinned item", () => {
  assert.equal(
    autoRestorable({ state: "archived", policy: "procedure_failed", pinned: false }),
    true,
  );
  assert.equal(autoRestorable({ state: "archived", policy: "stale", pinned: false }), false);
  assert.equal(
    autoRestorable({ state: "archived", policy: "procedure_failed", pinned: true }),
    false,
  );
  assert.equal(
    autoRestorable({ state: "active", policy: "procedure_failed", pinned: false }),
    false,
  );
});

// ---- 8 cap
test("8 cap: beyond N per owner and repository the least recently used are archived; pinned ones count but stay", () => {
  const items = Array.from({ length: 5 }, (_, n) =>
    item({ lastLoadedAt: ago(n + 1), createdAt: ago(300) }),
  );
  const decided = overCap(items, 3);
  assert.deepEqual([...decided.keys()].sort(), [items[3].id, items[4].id].sort(), "the two idlest");
  assert.equal(decided.get(items[3].id)?.policy, "cap");
  const pinned = [...items.slice(0, 3), { ...items[3], pinned: true }, items[4]];
  assert.deepEqual(
    [...overCap(pinned, 3).keys()],
    [items[4].id],
    "a pinned item is never archived",
  );
  assert.equal(overCap(items, 5).size, 0, "exactly at the cap");
  const mixed = [...items, item({ repo: "other" }), item({ ownerId: 2 })];
  assert.equal(overCap(mixed, 3).size, 2, "other repos and owners have their own budget");
  assert.equal(
    overCap(
      [
        ...items,
        item({ kind: "lesson" }),
        item({ kind: "conclusions", trust: "unverified", enabled: false }),
      ],
      5,
    ).size,
    0,
    "only run memory counts",
  );
});

// ---- purge
test("purge: archived long enough is deleted; pinned, young, or purge disabled are not", () => {
  const archived = (days: number, over: Partial<AgingItem> = {}) =>
    item({ state: "archived", stateAt: ago(days), policy: "stale", enabled: false, ...over });
  assert.equal(purge(archived(90), NOW, TH)?.action, "purge");
  assert.equal(purge(archived(89), NOW, TH), null);
  assert.equal(purge(archived(500, { pinned: true }), NOW, TH), null);
  assert.equal(purge(archived(500), NOW, { purgeDays: 0 }), null, "0 = never delete");
  assert.equal(purge(item(), NOW, TH), null, "active items are never purged");
  assert.equal(purge(archived(100, { state: "superseded" }), NOW, TH)?.action, "purge");
});

// ---- decide
test("decide: the documented order; a confirmed STALE wins over disuse, and an old-but-loaded item is left alone", () => {
  const all: AgingItem[] = [];
  const base = { now: NOW, thresholds: TH, all };
  const idle = item({ createdAt: ago(200) });
  assert.equal(
    decide(idle, { ...base, freshness: { state: "STALE", reason: "x" } }).decision?.policy,
    "stale",
  );
  assert.equal(
    decide(idle, { ...base, freshness: { state: "FRESH", reason: "" } }).decision?.policy,
    "disuse",
  );
  assert.equal(decide(item({ lastLoadedAt: ago(1) }), base).decision, null);
  const tracked = decide(item({ unknownSince: ago(20) }), {
    ...base,
    unknown: { code: "no_commit", permanent: true },
  });
  assert.equal(tracked.decision?.policy, "unknown");
  assert.equal(tracked.unknownCode, "no_commit");
  assert.equal(
    decide(item({ unknownSince: ago(20) }), {
      ...base,
      unknown: { code: "fetch_old", permanent: false },
    }).unknownSince,
    null,
  );
});
