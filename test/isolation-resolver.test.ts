/** Sandbox masks must not take name resolution with them (WSL: /etc/resolv.conf → /mnt/wsl/resolv.conf, masked). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolverRebinds } from "../src/agent/isolation.ts";

const fs: Record<string, string> = {
  "/etc/resolv.conf": "/mnt/wsl/resolv.conf",
  "/etc/hosts": "/etc/hosts",
  "/etc/nsswitch.conf": "/etc/nsswitch.conf",
  "/mnt/wsl": "/mnt/wsl",
  "/home/u/.ssh": "/home/u/.ssh",
};
const real = (p: string) => fs[p] ?? null;

test("a resolver file whose target is inside a masked directory is bound back read-only, alone", () => {
  assert.deepEqual(resolverRebinds(["/mnt/wsl", "/home/u/.ssh"], undefined, real), [
    "--ro-bind",
    "/mnt/wsl/resolv.conf",
    "/mnt/wsl/resolv.conf",
  ]);
});

test("nothing is re-exposed when no resolver file points into a mask", () => {
  assert.deepEqual(resolverRebinds(["/home/u/.ssh"], undefined, real), []);
  // A plain (non-symlink) resolver file is never mounted over itself.
  assert.deepEqual(resolverRebinds(["/etc"], ["/etc/hosts"], real), []);
  // Missing files are skipped.
  assert.deepEqual(resolverRebinds(["/mnt/wsl"], ["/etc/missing"], real), []);
});
