import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { instanceDirectory, unsafeRelativePath } from "../src/repos/paths.ts";

describe("unsafeRelativePath", () => {
  test("identifies absolute Unix and Windows paths as unsafe", () => {
    assert.equal(unsafeRelativePath("/etc/passwd"), true);
    assert.equal(unsafeRelativePath("/home/user/repo"), true);
    assert.equal(unsafeRelativePath("C:\\Windows\\System32"), true);
    assert.equal(unsafeRelativePath("d:/repos/proj"), true);
  });

  test("identifies UNC and leading slashes as unsafe", () => {
    assert.equal(unsafeRelativePath("\\\\server\\share"), true);
    assert.equal(unsafeRelativePath("//server/share"), true);
    assert.equal(unsafeRelativePath("/repo"), true);
    assert.equal(unsafeRelativePath("\\repo"), true);
  });

  test("identifies parent directory traversal as unsafe", () => {
    assert.equal(unsafeRelativePath(".."), true);
    assert.equal(unsafeRelativePath("../repo"), true);
    assert.equal(unsafeRelativePath("..\\repo"), true);
  });

  test("accepts safe relative repository paths", () => {
    assert.equal(unsafeRelativePath("repo"), false);
    assert.equal(unsafeRelativePath("repo/sub"), false);
    assert.equal(unsafeRelativePath("repo\\sub"), false);
    assert.equal(unsafeRelativePath("hasaki-oms-api"), false);
    assert.equal(unsafeRelativePath("repo.git"), false);
    assert.equal(unsafeRelativePath(""), false);
  });
});

describe("instanceDirectory", () => {
  test("returns 32-character hexadecimal sha256 prefix", () => {
    const dir = instanceDirectory("instance-42");
    assert.equal(typeof dir, "string");
    assert.equal(dir.length, 32);
    assert.match(dir, /^[0-9a-f]{32}$/);
  });

  test("is deterministic for identical IDs and distinct for different IDs", () => {
    assert.equal(instanceDirectory("inst-1"), instanceDirectory("inst-1"));
    assert.notEqual(instanceDirectory("inst-1"), instanceDirectory("inst-2"));
  });

  test("handles empty string ID", () => {
    const dir = instanceDirectory("");
    assert.equal(dir.length, 32);
    assert.match(dir, /^[0-9a-f]{32}$/);
  });
});
