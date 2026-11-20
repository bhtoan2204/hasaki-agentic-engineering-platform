import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  duplicateCoverage,
  isLive,
  lineDiff,
  ruleTerms,
  termChange,
} from "../src/knowledge/proposals.ts";

describe("ruleTerms", () => {
  test("extracts backticked, snake_case, dotted, and camelCase identifiers", () => {
    const text =
      "Check `order_amount` and `CalcTax` using user_account.balance and totalDiscountAmount.";
    const terms = ruleTerms(text);
    assert.ok(terms.has("order_amount"));
    assert.ok(terms.has("calctax"));
    assert.ok(terms.has("user_account.balance"));
    assert.ok(terms.has("totaldiscountamount"));
  });

  test("ignores plain single lowercase words unless backticked", () => {
    const text = "plain simple words without any identifier pattern";
    const terms = ruleTerms(text);
    assert.equal(terms.size, 0);

    const withBacktick = "plain `simple` words";
    const termsBacktick = ruleTerms(withBacktick);
    assert.equal(termsBacktick.size, 1);
    assert.ok(termsBacktick.has("simple"));
  });

  test("lowercases all extracted terms", () => {
    const text = "`MyService` API_END_POINT getUserDetails";
    const terms = ruleTerms(text);
    assert.ok(terms.has("myservice"));
    assert.ok(terms.has("api_end_point"));
    assert.ok(terms.has("getuserdetails"));
  });

  test("handles empty, null, or undefined input", () => {
    assert.equal(ruleTerms("").size, 0);
    const untypedRuleTerms = ruleTerms as (text: string | null | undefined) => Set<string>;
    assert.equal(untypedRuleTerms(null).size, 0);
    assert.equal(untypedRuleTerms(undefined).size, 0);
  });
});

describe("termChange", () => {
  test("identifies removed and added terms sorted alphabetically", () => {
    const oldRule = "Use `old_field` and `shared_term` for calculation.";
    const newRule = "Use `new_field` and `shared_term` with `extra_term`.";
    const change = termChange(oldRule, newRule);

    assert.deepEqual(change.removed, ["old_field"]);
    assert.deepEqual(change.added, ["extra_term", "new_field"]);
  });

  test("returns empty arrays for identical rules", () => {
    const rule = "Calculate line_amount with discount_percent.";
    const change = termChange(rule, rule);
    assert.deepEqual(change.removed, []);
    assert.deepEqual(change.added, []);
  });

  test("handles empty inputs", () => {
    const change = termChange("", "");
    assert.deepEqual(change.removed, []);
    assert.deepEqual(change.added, []);
  });
});

describe("lineDiff", () => {
  test("generates correct operations for identical, deleted, and added lines", () => {
    const before = "line1\nline2\nline3";
    const after = "line1\nline2_modified\nline3\nline4";
    const diff = lineDiff(before, after);

    assert.deepEqual(diff, [
      { op: " ", line: "line1" },
      { op: "-", line: "line2" },
      { op: "+", line: "line2_modified" },
      { op: " ", line: "line3" },
      { op: "+", line: "line4" },
    ]);
  });

  test("handles pure additions from empty before", () => {
    const diff = lineDiff("", "a\nb");
    assert.deepEqual(diff, [
      { op: "-", line: "" },
      { op: "+", line: "a" },
      { op: "+", line: "b" },
    ]);
  });

  test("handles pure deletions to empty after", () => {
    const diff = lineDiff("a\nb", "");
    assert.deepEqual(diff, [
      { op: "-", line: "a" },
      { op: "-", line: "b" },
      { op: "+", line: "" },
    ]);
  });

  test("handles identical single line", () => {
    const diff = lineDiff("single", "single");
    assert.deepEqual(diff, [{ op: " ", line: "single" }]);
  });

  test("respects maxLines truncation limit", () => {
    const before = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const after = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const diff = lineDiff(before, after, 5);
    assert.equal(diff.length, 5);
    assert.ok(diff.every((d) => d.op === " "));
  });
});

describe("duplicateCoverage", () => {
  test("returns true when items have matching scope, conflict_key, and applicability (regardless of key order)", () => {
    const item1 = {
      scope_type: "REPO",
      scope_ref: "org/repo-a",
      conflict_key: "audit_rule",
      applicability: { env: "prod", role: "admin" },
    };
    const item2 = {
      scope_type: "REPO",
      scope_ref: "org/repo-a",
      conflict_key: "audit_rule",
      applicability: { role: "admin", env: "prod" }, // reversed key order
    };
    assert.equal(duplicateCoverage([item1, item2]), true);
  });

  test("returns false when scope_type, scope_ref, or conflict_key differ", () => {
    const base = {
      scope_type: "REPO",
      scope_ref: "org/repo-a",
      conflict_key: "k1",
      applicability: null,
    };
    assert.equal(duplicateCoverage([base, { ...base, scope_type: "GLOBAL" }]), false);
    assert.equal(duplicateCoverage([base, { ...base, scope_ref: "org/repo-b" }]), false);
    assert.equal(duplicateCoverage([base, { ...base, conflict_key: "k2" }]), false);
  });
});

describe("isLive", () => {
  const now = new Date("2026-11-20T12:00:00.000Z");

  test("returns true when no dates are set", () => {
    assert.equal(isLive({}, now), true);
  });

  test("returns true when within effective and expiration window", () => {
    const item = {
      effective_from: "2026-11-01T00:00:00.000Z",
      expires_at: "2026-12-01T00:00:00.000Z",
    };
    assert.equal(isLive(item, now), true);
  });

  test("returns false when expired", () => {
    const item = {
      expires_at: "2026-11-19T00:00:00.000Z",
    };
    assert.equal(isLive(item, now), false);
  });

  test("returns false when effective_from is in the future", () => {
    const item = {
      effective_from: "2026-11-21T00:00:00.000Z",
    };
    assert.equal(isLive(item, now), false);
  });
});
