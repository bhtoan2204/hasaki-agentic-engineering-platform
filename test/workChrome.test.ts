import { existingChromeOwner } from "../src/existingWorkChrome.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromeProfilePath, cancelChrome, connectionStatus, localChromeEnabled, openChrome } from "../src/workChrome.ts";

test("hosted refuses Chrome; local sessions isolate users and handle missing Chrome/cancel/duplicates", async () => {
  const old = { mode: process.env.HASAKI_WORK_BROWSER_MODE, path: process.env.HASAKI_WORK_CHROME_PATH, host: process.env.HOST };
  try {
    delete process.env.HASAKI_WORK_BROWSER_MODE;
    await assert.rejects(openChrome(81, async () => {}), /chrome_hosted/);
    process.env.HASAKI_WORK_BROWSER_MODE = "local";
    process.env.HOST = "0.0.0.0";
    assert.equal(localChromeEnabled(), false);
    process.env.HOST = "127.0.0.1";
    process.env.HASAKI_WORK_CHROME_PATH = "/missing-chrome";
    // Explicit paths must not silently select another browser.
    await openChrome(81, async () => {});
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(connectionStatus(81).connectionError, "chrome_missing");
    assert.equal(connectionStatus(82).connectionState, "idle");
    await cancelChrome(82);
    assert.equal(connectionStatus(81).connectionState, "error");
  } finally {
    for (const [k,v] of Object.entries({ HASAKI_WORK_BROWSER_MODE: old.mode, HASAKI_WORK_CHROME_PATH: old.path, HOST: old.host })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("mock process lifecycle: duplicate open, actor cancellation, and timeout", async () => {
  const root = mkdtempSync(join(tmpdir(), "work-chrome-"));
  const executable = join(root, "mock-chrome");
  writeFileSync(executable, "#!/bin/sh\nexec sleep 30\n", { mode: 0o700 });
  const old = { mode: process.env.HASAKI_WORK_BROWSER_MODE, path: process.env.HASAKI_WORK_CHROME_PATH, host: process.env.HOST, dir: config.dataDir };
  try {
    process.env.HASAKI_WORK_BROWSER_MODE = "local"; process.env.HASAKI_WORK_CHROME_PATH = executable; process.env.HOST = "127.0.0.1"; config.dataDir = root;
    await openChrome(91, async () => {}, 5000);
    await openChrome(91, async () => { throw new Error("duplicate"); });
    await openChrome(92, async () => {}, 30);
    await cancelChrome(91);
    assert.equal(connectionStatus(91).connectionState, "cancelled");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(connectionStatus(92).connectionState, "timeout");
  } finally {
    await cancelChrome(91); await cancelChrome(92); config.dataDir = old.dir;
    for (const [k,v] of Object.entries({ HASAKI_WORK_BROWSER_MODE: old.mode, HASAKI_WORK_CHROME_PATH: old.path, HOST: old.host })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("profile identity is stable and isolated by user and installation", () => {
  assert.equal(chromeProfilePath("/tmp/root", "install-a", 1), chromeProfilePath("/tmp/root", "install-a", 1));
  assert.notEqual(chromeProfilePath("/tmp/root", "install-a", 1), chromeProfilePath("/tmp/root", "install-a", 2));
  assert.notEqual(chromeProfilePath("/tmp/root", "install-a", 1), chromeProfilePath("/tmp/root", "install-b", 1));
  assert.throws(() => chromeProfilePath("/tmp/root", "install-a", -1));
});

test("personal Chrome is pinned to the configured authenticated actor", async () => {
  const prior = { owner: process.env.HASAKI_WORK_EXISTING_CHROME_USER, mode: process.env.HASAKI_WORK_BROWSER_MODE, profile: process.env.HASAKI_WORK_CHROME_PROFILE, host: process.env.HOST };
  try {
    delete process.env.HASAKI_WORK_EXISTING_CHROME_USER;
    assert.equal(existingChromeOwner("toan"), false);
    process.env.HASAKI_WORK_EXISTING_CHROME_USER = "toan";
    assert.equal(existingChromeOwner("toan"), true);
    assert.equal(existingChromeOwner("other"), false);
    assert.equal(existingChromeOwner(undefined), false);
    process.env.HASAKI_WORK_BROWSER_MODE = "local";
    process.env.HASAKI_WORK_CHROME_PROFILE = "existing";
    process.env.HOST = "127.0.0.1";
    await assert.rejects(openChrome(123, async () => {}, 1000, "other"), /chrome_existing_owner/);
    assert.equal(connectionStatus(123).connectionState, "idle");
  } finally {
    for (const [k,v] of Object.entries({ HASAKI_WORK_EXISTING_CHROME_USER: prior.owner, HASAKI_WORK_BROWSER_MODE: prior.mode, HASAKI_WORK_CHROME_PROFILE: prior.profile, HOST: prior.host })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
