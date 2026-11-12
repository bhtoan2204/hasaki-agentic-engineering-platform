import { test } from "node:test";
import assert from "node:assert/strict";
import { artifactResponseHeaders } from "../src/http/artifactResponse.ts";

test("untrusted stored executable content is downloaded regardless of metadata", () => {
  for (const mime of ["text/html", "image/svg+xml", "application/pdf", "image/png", undefined, { bad: true }]) {
    const headers = artifactResponseHeaders('bad"\r\nInjected: yes/evil.html', mime, Buffer.from('<script>alert(1)</script>'));
    assert.equal(headers["Content-Type"], "application/octet-stream");
    assert.match(headers["Content-Disposition"], /^attachment; filename="[^"\r\n/]*"$/);
    assert.equal(headers["Cache-Control"], "no-store");
    assert.equal(headers["X-Content-Type-Options"], "nosniff");
    assert.match(headers["Content-Security-Policy"], /sandbox/);
    assert.match(headers["Content-Security-Policy"], /default-src 'none'/);
  }
});

test("only matching passive raster signatures retain inline previews", () => {
  for (const [mime, hex] of [
    ["image/png", "89504e470d0a1a0a"], ["image/jpeg", "ffd8ff"],
    ["image/gif", "474946383961"], ["image/webp", "524946460400000057454250"],
  ]) {
    const bytes = Buffer.from(hex, "hex");
    assert.equal(artifactResponseHeaders("image", mime, bytes)["Content-Type"], mime);
    assert.match(artifactResponseHeaders("image", mime, bytes)["Content-Disposition"], /^inline;/);
    assert.equal(artifactResponseHeaders("image", "text/html", bytes)["Content-Type"], "application/octet-stream");
    assert.equal(artifactResponseHeaders("image", mime, bytes.subarray(0, 2))["Content-Type"], "application/octet-stream");
  }
});

test("textual artifacts remain escaped by a plain-text response", () => {
  const headers = artifactResponseHeaders("report.txt", "text/html", null);
  assert.equal(headers["Content-Type"], "text/plain; charset=utf-8");
  assert.match(headers["Content-Disposition"], /^inline;/);
  assert.equal(headers["Cache-Control"], "no-store");
});
