import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isPublicHttps, linkFooter, telegramUrl } from "../src/telegram.ts";

describe("telegramUrl", () => {
  test("rewrites localhost to 127.0.0.1", () => {
    assert.equal(telegramUrl("http://localhost:3000/runs/1"), "http://127.0.0.1:3000/runs/1");
    assert.equal(telegramUrl("https://localhost/#/runs/1"), "https://127.0.0.1/#/runs/1");
    assert.equal(telegramUrl("http://localhost"), "http://127.0.0.1");
  });

  test("leaves public or IP hosts unchanged", () => {
    assert.equal(telegramUrl("https://app.example.vn/tasks"), "https://app.example.vn/tasks");
    assert.equal(telegramUrl("http://192.168.1.100:8080"), "http://192.168.1.100:8080");
  });
});

describe("isPublicHttps", () => {
  test("returns true for public HTTPS URLs", () => {
    assert.equal(isPublicHttps("https://app.example.vn/runs/42"), true);
    assert.equal(isPublicHttps("https://sub.example.com:8443/api"), true);
    assert.equal(isPublicHttps("https://github.com/org/repo"), true);
  });

  test("returns false for non-HTTPS protocols", () => {
    assert.equal(isPublicHttps("http://example.com"), false);
    assert.equal(isPublicHttps("ftp://example.com"), false);
  });

  test("returns false for loopback and private local hosts", () => {
    assert.equal(isPublicHttps("https://localhost:3000"), false);
    assert.equal(isPublicHttps("https://127.0.0.1:8080/path"), false);
    assert.equal(isPublicHttps("https://0.0.0.0:8000"), false);
    assert.equal(isPublicHttps("https://[::1]:8080"), false);
  });

  test("returns false for empty or malformed inputs", () => {
    assert.equal(isPublicHttps(""), false);
    assert.equal(isPublicHttps("   "), false);
    assert.equal(isPublicHttps("not-a-url"), false);
  });
});

describe("linkFooter", () => {
  test("returns inline keyboard button for public HTTPS URLs", () => {
    const footer = linkFooter("https://app.example.vn/#/runs/10/step", "Open step");
    assert.equal(footer.text, "");
    assert.deepEqual(footer.reply_markup, {
      inline_keyboard: [[{ text: "Open step", url: "https://app.example.vn/#/runs/10/step" }]],
    });
  });

  test("rewrites localhost and returns HTML text link with no reply_markup", () => {
    const footer = linkFooter("http://localhost:3000/#/runs/5", "Mở để duyệt");
    assert.equal(footer.reply_markup, undefined);
    assert.equal(footer.text, '👉 <a href="http://127.0.0.1:3000/#/runs/5">Mở để duyệt</a>');
  });

  test("escapes special HTML characters in label and URL", () => {
    const footer = linkFooter(
      'http://localhost:3000/#/runs/5?name="test"&type=1',
      'Open <script>alert("xss")</script> & review',
    );
    assert.equal(footer.reply_markup, undefined);
    assert.ok(footer.text.includes("&quot;test&quot;"));
    assert.ok(footer.text.includes("&lt;script&gt;"));
    assert.ok(footer.text.includes("&amp; review"));
    assert.doesNotMatch(footer.text, /<script>/);
  });
});
