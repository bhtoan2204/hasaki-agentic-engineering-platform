import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { ESLINT_NEW_ERRORS_JS } from "../src/workflow/templates.ts";

const root = path.resolve(import.meta.dirname, "..");
const hasEslint = (() => {
  try {
    createRequire(path.join(root, "package.json")).resolve("eslint");
    return true;
  } catch {
    return false;
  }
})();

test(
  "eslint gate fails only on errors the branch adds",
  { skip: !hasEslint && "eslint not installed" },
  (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "eslint-new-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd: dir,
        encoding: "utf8",
      });
    const write = (f: string, body: string) => writeFileSync(path.join(dir, f), body);
    symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"));
    copyFileSync(path.join(root, "eslint.config.mjs"), path.join(dir, "eslint.config.mjs"));
    mkdirSync(path.join(dir, "src"));
    write("package.json", '{"type":"module"}');
    write(".gitignore", "node_modules\n");
    write("src/a.ts", "export const a: any = 1;\n");
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").trim();
    const lint = (files: string[]) =>
      spawnSync("node", ["-e", ESLINT_NEW_ERRORS_JS], {
        cwd: dir,
        input: files.join("\n") + "\n",
        env: { ...process.env, LINT_BASE: base },
        encoding: "utf8",
      });

    // Pre-existing error on a shifted line: ignored.
    write("src/a.ts", "// moved\n\nexport const a: any = 1;\n");
    git("commit", "-qam", "touch");
    let r = lint(["src/a.ts"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /1 error\(s\) already present/);

    // One more of the same error in an old file, plus a new file: both counted.
    write("src/a.ts", "export const a: any = 1;\nexport const b: any = 2;\n");
    write("src/new.ts", "export const c: any = 3;\n");
    git("add", "-A");
    git("commit", "-qm", "worse");
    r = lint(["src/a.ts", "src/new.ts"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /2 new eslint error\(s\)/);
    assert.match(r.stdout, /no-explicit-any/);
  },
);
