/**
 * Blank page after navigation (stale build): a failed lazy chunk is recognised and recovered by one reload, never a
 * reload loop; other render errors are shown, not reloaded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isChunkLoadError, reloadOnce } from "../web/src/pageRecovery.ts";

test("chunk load failures from every browser are recognised; ordinary errors are not", () => {
  for (const message of [
    "Failed to fetch dynamically imported module: http://localhost:4545/assets/RunView-0ld.js",
    "Importing a module script failed.",
    "error loading dynamically imported module: http://localhost:4545/assets/Chat-0ld.js",
    "Unable to preload CSS for /assets/Runs-0ld.css",
    "'text/html' is not a valid JavaScript MIME type.",
  ])
    assert.equal(isChunkLoadError(new Error(message)), true, message);
  assert.equal(isChunkLoadError(Object.assign(new Error("x"), { name: "ChunkLoadError" })), true);
  assert.equal(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')")), false);
  assert.equal(isChunkLoadError("nope"), false);
});

test("reload once: a second failure within the window shows the error instead of looping", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  assert.equal(reloadOnce(storage, 1_000_000), true);
  assert.equal(reloadOnce(storage, 1_010_000), false, "10 s later: still the same broken build");
  assert.equal(reloadOnce(storage, 1_100_000), true, "much later: a new rebuild may have happened");
  const broken = {
    getItem: () => {
      throw new Error("storage blocked");
    },
    setItem: () => {
      throw new Error("storage blocked");
    },
  };
  assert.equal(reloadOnce(broken, 1), false, "no storage: never risk a loop");
});
