import { test } from "node:test";
import assert from "node:assert/strict";
import { LruMap, provenanceProblem } from "../src/knowledge/memory.ts";

test("LruMap evicts the least recently used entry beyond its bound and a hit refreshes an entry", () => {
  const lru = new LruMap<string, number>(3);
  lru.set("a", 1);
  lru.set("b", 2);
  lru.set("c", 3);
  assert.equal(lru.get("a"), 1, "a is now the most recently used");
  lru.set("d", 4);
  assert.equal(lru.get("b"), undefined, "b was the least recently used");
  assert.deepEqual([lru.get("a"), lru.get("c"), lru.get("d")], [1, 3, 4]);
  assert.equal(lru.size, 3);
});

test("LruMap stays bounded however many keys are inserted (keys change with every fetch)", () => {
  const lru = new LruMap<string, string>(50);
  for (let i = 0; i < 10_000; i++) lru.set(`repo|commit|${i}|f`, "FRESH");
  assert.equal(lru.size, 50);
  assert.equal(lru.get("repo|commit|9999|f"), "FRESH");
  assert.equal(lru.get("repo|commit|0|f"), undefined);
});

test("provenanceProblem names why a memory item can never be proven fresh", () => {
  const ok = { commit_sha: "abcdef1234567", files: ["a.go"] };
  assert.equal(provenanceProblem(ok), null);
  assert.equal(provenanceProblem(undefined)?.code, "no_provenance");
  assert.equal(provenanceProblem({ ...ok, commit_sha: "" })?.code, "no_commit");
  assert.equal(provenanceProblem({ ...ok, commit_sha: "not-a-sha" })?.code, "no_commit");
  assert.equal(provenanceProblem({ commit_sha: ok.commit_sha })?.code, "no_file_list");
  assert.equal(
    provenanceProblem({ ...ok, files: [] }),
    null,
    "an empty file list is complete provenance",
  );
});
