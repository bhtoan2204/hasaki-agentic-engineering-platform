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

test("Markdown preserves percent-encoded relative filenames without admitting encoded schemes", () => {
  const html = renderMarkdownSafe('[report](report%20final.pdf) ![plot](plot%20one.png) [unicode](r%C3%A9sum%C3%A9.pdf)');
  assert.match(html, /href="report%20final.pdf"/);
  assert.match(html, /src="plot%20one.png"/);
  assert.match(html, /href="r%C3%A9sum%C3%A9.pdf"/);
  for (const url of ['javascript%3Aalert(1)', 'javascript%253Aalert(1)', '%2F%2Fevil.invalid/x', 'java%09script%3Aevil', 'javascript%26colon%3Bevil']) {
    assert.doesNotMatch(renderMarkdownSafe(`[link](${url}) ![image](${url})`), /<a\b|<img\b/);
  }
});
