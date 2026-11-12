import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdownSafe } from "../web/src/markdown.ts";

test("Markdown rejects executable and obscured link/image schemes", () => {
  for (const url of ["javascript:alert%281%29", "JaVaScRiPt:alert%281%29", "java&#x73;cript:alert%281%29", "javascript&colon;alert%281%29", "java%0ascript:alert%281%29", "data:text/html,evil", "vbscript:evil", "file:///tmp/secret"]) {
    const html = renderMarkdownSafe(`[link](${url}) ![image](${url})`);
    assert.doesNotMatch(html, /<a\b|<img\b/i, url);
    assert.match(html, /link/);
    assert.match(html, /image/);
  }
});

test("Markdown escapes raw HTML and retains passive formatting and safe URLs", () => {
  const html = renderMarkdownSafe('<script>alert(1)</script>\n\n**bold** [web](https://example.invalid/x?q=1&b=2) [local](./report.md) [mail](mailto:user@example.invalid) ![image](https://example.invalid/image.png)');
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /href="https:\/\/example.invalid\/x\?q=1&amp;b=2"/);
  assert.match(html, /href="\.\/report.md"/);
  assert.match(html, /href="mailto:user@example.invalid"/);
  assert.match(html, /<img src="https:\/\/example.invalid\/image.png"/);
});
