import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeRequirement, parseAiSuggest } from "../src/report/aiSuggest.ts";
import { buildReport, renderMarkdown } from "../src/report/build.ts";
import type { Evidence } from "../src/report/evidence.ts";

const PAYLOAD = {
  task_ai: {
    ai_verify: null,
    ai_suggest: {
      suggest_id: "855580c2-37ae-58d8-b93a-54dce694a2c6",
      has_report_constraints: false,
      report: {
        "Kết quả test đơn hàng": [
          "Ảnh chụp thông tin đơn hàng sau khi fix hiển thị đầy đủ postal_code trong customer_info",
        ],
        "Kiểm tra luồng mapping ZIP Code": [
          "Ảnh chụp code hoặc log thể hiện việc sửa lỗi mapping trường postal_code từ Ecom sang OMS",
        ],
      },
      reasoning:
        "Staff cần báo cáo bằng chứng đã sửa lỗi mapping postal_code và kết quả kiểm tra lại.",
      task_readiness: 0.8,
      object: "Mã đơn hàng",
      object_value: "261030US91TZ",
    },
  },
};

test("ai_suggest: valid report parsed with sections, ids, metadata, language", () => {
  const s = parseAiSuggest(PAYLOAD)!;
  assert.equal(s.suggest_id, "855580c2-37ae-58d8-b93a-54dce694a2c6");
  assert.equal(s.object_value, "261030US91TZ");
  assert.equal(s.language, "vi");
  assert.equal(s.sections.length, 2);
  assert.deepEqual(s.sections.map((x) => x.name).sort(), [
    "Kiểm tra luồng mapping ZIP Code",
    "Kết quả test đơn hàng",
  ]);
  assert.match(s.sections[0].requirements[0].id, /^S1\.R1$/);
  assert.ok(!("task_readiness" in s), "readiness is not used");
});

test("ai_suggest: null, missing, empty or blank reports produce no spec", () => {
  for (const p of [
    null,
    {},
    { task_ai: null },
    { task_ai: { ai_suggest: null } },
    { task_ai: { ai_suggest: { report: null } } },
    { task_ai: { ai_suggest: { report: {} } } },
    { task_ai: { ai_suggest: { report: { A: [], B: ["  "] } } } },
    { task_ai: { ai_suggest: { report: ["x"] } } },
  ])
    assert.equal(parseAiSuggest(p), null, JSON.stringify(p));
});

test("ai_suggest: multiple categories, string values, empty sections dropped", () => {
  const s = parseAiSuggest({
    task_ai: {
      ai_suggest: {
        report: {
          Empty: [],
          Deploy: "Log deploy lên QC",
          Tests: ["Kết quả unit test", "Ảnh chụp màn hình trang đơn hàng"],
        },
      },
    },
  })!;
  assert.deepEqual(
    s.sections.map((x) => [x.name, x.requirements.length]),
    [
      ["Deploy", 1],
      ["Tests", 2],
    ],
  );
});

test("requirement analysis: screenshot-only vs alternatives (code hoặc log)", () => {
  const a = analyzeRequirement(
    "Ảnh chụp thông tin đơn hàng sau khi fix hiển thị đầy đủ postal_code",
  );
  assert.ok(a.screenshotOnly && a.outcome);
  assert.deepEqual(a.accepts.sort(), ["attachment", "note", "screenshot"]);
  const b = analyzeRequirement("Ảnh chụp code hoặc log thể hiện việc sửa lỗi mapping");
  assert.ok(!b.screenshotOnly);
  assert.ok(
    b.accepts.includes("commit") && b.accepts.includes("log") && b.accepts.includes("screenshot"),
  );
});

const spec = parseAiSuggest(PAYLOAD)!;
const shot = spec.sections.find((s) => s.name.startsWith("Kết quả"))!.requirements[0];
const codeReq = spec.sections.find((s) => s.name.startsWith("Kiểm tra"))!.requirements[0];
const EV: Evidence[] = [
  {
    id: "E1",
    kind: "implementation_summary",
    title: "implement",
    detail: "fixed ZIP+4 mapping",
    ref: { step_key: "implement" },
  },
  {
    id: "E2",
    kind: "commit",
    title: "inside-product-worker-usa abc fix(zip): strip ZIP+4",
    detail: "",
    ref: { commit: "abc" },
  },
  { id: "E3", kind: "test_result", title: "test failed", detail: "", ref: {}, passed: false },
  {
    id: "E4",
    kind: "task_attachment",
    title: "Task attachment",
    detail: "",
    ref: {},
    before_fix: true,
  },
];
const allVerified = {
  summary: "Đã sửa.",
  requirements: [shot, codeReq].map((r) => ({
    id: r.id,
    status: "VERIFIED" as const,
    evidence_ids: ["E1", "E2", "E3", "E4", "E99"],
    explanation: "ok",
  })),
};
const meta = { task: { code: "HSK-1", title: "ZIP", id: 1 }, fallbackSummary: "x" };

test("missing screenshot: an over-eager reasoner cannot verify it; code verifies the code requirement; fabricated/irrelevant ids dropped", () => {
  const r = buildReport(spec, EV, allVerified, meta);
  const got = Object.fromEntries(r.sections.flatMap((s) => s.requirements).map((x) => [x.id, x]));
  assert.equal(got[shot.id].status, "MISSING");
  assert.match(got[shot.id].rule, /no screenshot/);
  assert.equal(got[codeReq.id].status, "VERIFIED");
  assert.deepEqual(
    got[codeReq.id].evidence.map((e) => e.id).sort(),
    ["E1", "E2"],
    "failed test, pre-fix attachment and E99 are not evidence",
  );
  assert.match(got[codeReq.id].explanation, /E3|E4|E99/);
  assert.equal(r.counts.MISSING, 1);
  assert.ok(r.limitations.some((l) => l.startsWith(shot.id)));
});

test("partial: outcome requirement backed only by code stays PARTIAL; stale/unlinked screenshots are not enough", () => {
  const outcome = parseAiSuggest({
    task_ai: {
      ai_suggest: { report: { R: ["Đơn hàng hiển thị đầy đủ postal_code sau khi fix"] } },
    },
  })!;
  const id = outcome.sections[0].requirements[0].id;
  const r = buildReport(
    outcome,
    EV,
    { requirements: [{ id, status: "VERIFIED", evidence_ids: ["E1", "E2"] }] },
    meta,
  );
  assert.equal(r.sections[0].requirements[0].status, "PARTIAL");
  const unlinked: Evidence = {
    id: "E5",
    kind: "screenshot",
    title: "Ảnh: order.png",
    detail: "",
    ref: { artifact_id: 9 },
    image: true,
    requirement_id: null,
  };
  const citesE5 = {
    requirements: [{ id: shot.id, status: "VERIFIED" as const, evidence_ids: ["E5"] }],
  };
  const find = (r: ReturnType<typeof buildReport>) =>
    r.sections.flatMap((s) => s.requirements).find((x) => x.id === shot.id)!;
  const un = find(buildReport(spec, [...EV, unlinked], citesE5, meta));
  assert.equal(
    un.status,
    "PARTIAL",
    "a cited screenshot that the user did not attach to this requirement is only partial",
  );
  assert.match(un.rule, /not attached/);
  assert.equal(
    find(buildReport(spec, [...EV, unlinked], allVerified, meta)).status,
    "MISSING",
    "not cited, not attached → not considered",
  );
  const stale: Evidence = { ...unlinked, id: "E6", requirement_id: shot.id, stale: true };
  const st = buildReport(spec, [...EV, stale], allVerified, meta)
    .sections.flatMap((s) => s.requirements)
    .find((x) => x.id === shot.id)!;
  assert.equal(st.status, "MISSING");
});

test("verified: a screenshot the user attached to the requirement verifies it (with or without the reasoner)", () => {
  const linked: Evidence = {
    id: "E7",
    kind: "screenshot",
    title: "Ảnh: order.png",
    detail: "",
    ref: { artifact_id: 10 },
    image: true,
    requirement_id: shot.id,
  };
  for (const proposal of [allVerified, null]) {
    const x = buildReport(spec, [...EV, linked], proposal, meta)
      .sections.flatMap((s) => s.requirements)
      .find((q) => q.id === shot.id)!;
    assert.equal(x.status, "VERIFIED", String(!!proposal));
    assert.deepEqual(
      x.evidence.map((e) => e.id),
      ["E7"],
    );
  }
  const rulesOnly = buildReport(spec, EV, null, meta);
  assert.equal(
    rulesOnly.sections.flatMap((s) => s.requirements).find((q) => q.id === codeReq.id)!.status,
    "PARTIAL",
    "without reasoning nothing is auto-verified",
  );
  assert.equal(rulesOnly.generated_by, "rules");
});

test("markdown follows the requested sections in Vietnamese and states missing evidence", () => {
  const md = renderMarkdown(buildReport(spec, EV, allVerified, meta), {
    by: "toan",
    comment: "ok",
  });
  assert.match(md, /# Báo cáo kết quả task: HSK-1 ZIP/);
  assert.match(md, /Mã đơn hàng — `261030US91TZ`/);
  assert.match(md, /## Kết quả test đơn hàng/);
  assert.match(md, /❌ \*\*THIẾU\*\* — Ảnh chụp thông tin đơn hàng/);
  assert.match(md, /## Thiếu bằng chứng \/ giới hạn/);
  assert.match(md, /## Phê duyệt/);
});
