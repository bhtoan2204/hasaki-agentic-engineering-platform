/**
 * Promise-based application dialog service (no DOM). Covers settle-once, cancel on dismiss,
 * and safe queueing without calling native alert/confirm/prompt.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  dialog,
  dismissActiveDialog,
  resolveDialog,
  subscribeDialog,
} from "../web/src/dialog/service.ts";

afterEach(() => {
  dialog._reset();
});

describe("dialog.confirm", () => {
  it("resolves true when confirmed", async () => {
    const pending = dialog.confirm({ title: "Delete?" });
    assert.equal(dialog._peek().current?.kind, "confirm");
    resolveDialog(true);
    assert.equal(await pending, true);
    assert.equal(dialog._peek().current, null);
  });

  it("resolves false when cancelled", async () => {
    const pending = dialog.confirm({ title: "Delete?" });
    resolveDialog(false);
    assert.equal(await pending, false);
  });

  it("resolves false when dismissed via Escape/unmount helper", async () => {
    const pending = dialog.confirm({ title: "Delete?", variant: "destructive" });
    dismissActiveDialog();
    assert.equal(await pending, false);
  });
});

describe("dialog.prompt", () => {
  it("resolves the submitted string", async () => {
    const pending = dialog.prompt({ title: "Name", defaultValue: "a" });
    resolveDialog("branch-x");
    assert.equal(await pending, "branch-x");
  });

  it("resolves null on cancel", async () => {
    const pending = dialog.prompt({ title: "Name" });
    resolveDialog(null);
    assert.equal(await pending, null);
  });
});

describe("dialog.alert", () => {
  it("resolves void when acknowledged", async () => {
    const pending = dialog.alert({ title: "Saved" });
    resolveDialog(undefined);
    assert.equal(await pending, undefined);
  });
});

describe("dialog queue", () => {
  it("queues a second request until the first settles", async () => {
    const first = dialog.confirm({ title: "One" });
    const second = dialog.confirm({ title: "Two" });
    assert.equal(dialog._peek().queued, 1);
    assert.equal((dialog._peek().current as { options: { title: string } }).options.title, "One");
    resolveDialog(true);
    assert.equal(await first, true);
    assert.equal((dialog._peek().current as { options: { title: string } }).options.title, "Two");
    resolveDialog(false);
    assert.equal(await second, false);
  });

  it("settles every queued promise on dismissActiveDialog", async () => {
    const a = dialog.confirm({ title: "A" });
    const b = dialog.prompt({ title: "B" });
    const c = dialog.alert({ title: "C" });
    dismissActiveDialog();
    assert.deepEqual(await Promise.all([a, b, c]), [false, null, undefined]);
    assert.equal(dialog._peek().current, null);
    assert.equal(dialog._peek().queued, 0);
  });

  it("does not settle the same request twice", async () => {
    let settles = 0;
    const pending = dialog.confirm({ title: "Once" }).then((v) => {
      settles += 1;
      return v;
    });
    resolveDialog(true);
    resolveDialog(false); // ignored — already settled
    assert.equal(await pending, true);
    assert.equal(settles, 1);
  });
});

describe("subscribeDialog", () => {
  it("notifies listeners of the active request", () => {
    const seen: Array<string | null> = [];
    const unsub = subscribeDialog((req) => seen.push(req?.kind ?? null));
    void dialog.confirm({ title: "X" });
    resolveDialog(true);
    unsub();
    assert.deepEqual(
      seen.filter((x, i) => i === 0 || x !== seen[i - 1]),
      [null, "confirm", null],
    );
  });
});
