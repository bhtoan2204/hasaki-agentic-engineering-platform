/**
 * Static regression: application UI must not call native browser dialogs.
 * Exceptions: documented browser-controlled surfaces (beforeunload) are not alert/confirm/prompt.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const SCAN = [join(ROOT, "web/src"), join(ROOT, "public")];

/** Allowlisted files that define the replacement API (method names only, never call natives). */
const ALLOW = new Set([
  "web/src/dialog/service.ts",
  "web/src/dialog/types.ts",
  "web/src/dialog/index.ts",
  "public/app-dialog.js",
]);

const BANNED =
  /(?<![.\w$])(?:window\.|globalThis\.)?(?:alert|confirm|prompt)\s*\(/g;

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|jsx)$/.test(name)) out.push(p);
  }
  return out;
}

function stripNoise(src: string) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*\1/g, '""');
}

describe("no native browser dialogs", () => {
  it("web/src and public have no alert/confirm/prompt call sites", () => {
    const hits: string[] = [];
    for (const root of SCAN) {
      for (const file of walk(root)) {
        const rel = relative(ROOT, file).replace(/\\/g, "/");
        if (ALLOW.has(rel)) continue;
        // i18n catalogs mention "system prompt" in string values — skip pure message tables.
        if (rel.includes("/i18n/catalog.ts") || rel.includes("/i18n/messages.ts")) continue;
        const raw = readFileSync(file, "utf8");
        const src = stripNoise(raw);
        BANNED.lastIndex = 0;
        if (BANNED.test(src)) hits.push(rel);
      }
    }
    assert.deepEqual(hits, [], `Native dialog call sites remain:\n${hits.join("\n")}`);
  });
});
