import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fallbackTitle, sanitizeGeneratedTitle } from "../src/chat/title.ts";

describe("chat title helpers", () => {
  it("fallbackTitle keeps short messages and truncates long ones by words", () => {
    assert.equal(fallbackTitle("  Fix payment timeout  "), "Fix payment timeout");
    assert.equal(
      fallbackTitle("one two three four five six seven eight nine"),
      "one two three four five six",
    );
  });

  it("fallbackTitle collapses whitespace and caps length", () => {
    const long = "x".repeat(200);
    assert.equal(fallbackTitle(long).length, 72);
    assert.equal(fallbackTitle("a\n\nb\t\tc"), "a b c");
  });

  it("sanitizeGeneratedTitle strips quotes, prefixes and trailing punctuation", () => {
    assert.equal(sanitizeGeneratedTitle('"Payment timeout fix."', "fallback"), "Payment timeout fix");
    assert.equal(sanitizeGeneratedTitle("Title: OMS checkout bug", "fallback"), "OMS checkout bug");
    assert.equal(sanitizeGeneratedTitle("Tiêu đề: Sửa lỗi thanh toán", "fallback"), "Sửa lỗi thanh toán");
  });

  it("sanitizeGeneratedTitle falls back when model returns empty", () => {
    assert.equal(sanitizeGeneratedTitle("   ", "Seed title"), "Seed title");
  });

  it("sanitizeGeneratedTitle caps very long wordy titles", () => {
    const words = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    const out = sanitizeGeneratedTitle(words, "fb");
    assert.ok(out.split(" ").length <= 8);
  });
});
