import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { messages } from "../shared/i18n/messages.ts";
import { catalog } from "../shared/i18n/catalog.ts";

const root = join(import.meta.dirname, "..");

test("every UI key exists in both locales (vi and en)", () => {
  const vi = new Set(Object.keys(messages.vi));
  const en = new Set(Object.keys(messages.en));
  assert.deepEqual(
    [...vi].filter((key) => !en.has(key)),
    [],
    "keys present only in vi",
  );
  assert.deepEqual(
    [...en].filter((key) => !vi.has(key)),
    [],
    "keys present only in en",
  );
});

test("catalog namespace files do not overlap, so merging them never drops a key", async () => {
  const dir = join(root, "shared", "i18n", "catalog");
  let total = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const exported = Object.values(await import(join(dir, file)))[0] as Record<
      "vi" | "en",
      Record<string, string>
    >;
    assert.deepEqual(
      Object.keys(exported.vi).sort(),
      Object.keys(exported.en).sort(),
      `${file}: vi and en keys differ`,
    );
    total += Object.keys(exported.vi).length;
  }
  assert.equal(Object.keys(catalog.vi).length, total, "a key appears in two namespace files");
  assert.equal(Object.keys(catalog.en).length, total);
});

test("the backend does not import from web/ (shared dictionaries live in shared/)", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (
        /\.(ts|mjs)$/.test(name) &&
        /from\s+["'](?:\.\.\/)+web\//.test(readFileSync(path, "utf8"))
      )
        offenders.push(path.slice(root.length + 1));
    }
  };
  walk(join(root, "src"));
  assert.deepEqual(offenders, []);
});
