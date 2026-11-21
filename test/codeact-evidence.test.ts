/**
 * CodeAct evidence integrity (M1): the broker tracks whether each nested call's evidence was durably recorded and never
 * hides a recording failure. The surfaces turn this into references (test/codeact-evidence.integration.ts); here the
 * executor's own accounting is checked with a plain child process as the launcher.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { executeCode, type CallRecord, type Launcher } from "../src/codeact/execute.ts";

const DEFAULTS = { ...config.codeAct };
afterEach(() => Object.assign(config.codeAct, DEFAULTS));

const plainNode: Launcher = async (node, args) => ({
  command: node,
  args,
  env: { PATH: process.env.PATH ?? "" },
});
const TOOLS = [{ name: "echo", summary: "", readOnly: true }];
const echo = async (_n: string, args: unknown) => ({ ok: true, result: args });
const run = (code: string, record: (c: CallRecord) => Promise<void> | void, signal?: AbortSignal) =>
  executeCode({ code }, { tools: () => TOOLS, call: echo, launch: plainNode, record, signal });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("every recorded call is marked persisted", async () => {
  const r = await run(
    `return [await platform.callTool("echo", {i: 1}), await platform.callTool("echo", {i: 2})]`,
    async () => {},
  );
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.calls.map((c) => [c.seq, c.status, c.persisted]),
    [
      [1, "ok", true],
      [2, "ok", true],
    ],
  );
});

test("a failed recording is reported on the call, never swallowed; the program still gets its result", async () => {
  const r = await run(`return await platform.callTool("echo", {i: 1})`, async () => {
    throw new Error("insert failed: connection reset");
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { i: 1 });
  assert.equal(r.calls[0].persisted, false);
  assert.match(r.calls[0].persist_error ?? "", /connection reset/);
});

test("a recording that throws synchronously is a recording failure, not a crash", async () => {
  const r = await run(`return await platform.callTool("echo", {i: 1})`, () => {
    throw new Error("sync boom");
  });
  assert.equal(r.ok, true);
  assert.equal(r.calls[0].persisted, false);
});

test("partial failure: only the failing seq is unpersisted", async () => {
  const r = await run(
    `return await Promise.all([1,2,3].map((i) => platform.callTool("echo", {i})))`,
    async (c) => {
      if (c.seq === 2) throw new Error("unique violation");
    },
  );
  assert.deepEqual(
    r.calls.map((c) => [c.seq, c.persisted]),
    [
      [1, true],
      [2, false],
      [3, true],
    ],
  );
});

test("concurrent recordings all settle before the result is returned", async () => {
  let landed = 0;
  const r = await run(
    `return await Promise.all([1,2,3,4].map((i) => platform.callTool("echo", {i})))`,
    async (c) => {
      await sleep(40 - c.seq * 5);
      landed++;
    },
  );
  assert.equal(landed, 4, "the result waits for every recording");
  assert.ok(r.calls.every((c) => c.persisted === true));
});

test("a recording that never finishes times out and is reported unpersisted", async () => {
  config.codeAct.persistTimeoutMs = 100;
  const t0 = Date.now();
  const r = await run(
    `return await platform.callTool("echo", {i: 1})`,
    () => new Promise(() => {}),
  );
  assert.ok(Date.now() - t0 < 5000, "a hung recording does not hang the execution");
  assert.equal(r.calls[0].persisted, false);
  assert.match(r.calls[0].persist_error ?? "", /timed out/);
});

test("cancellation while a recording is in flight: the recording still settles and is reported", async () => {
  const ac = new AbortController();
  let landed = false;
  const p = run(
    `await platform.callTool("echo", {i: 1}); await new Promise(() => {});`,
    async () => {
      ac.abort("run canceled");
      await sleep(50);
      landed = true;
    },
    ac.signal,
  );
  const r = await p;
  assert.equal(r.category, "canceled");
  assert.equal(landed, true, "the in-flight row lands before the result");
  assert.equal(r.calls[0].persisted, true);
});

test("without a recorder, persistence is unknown (undefined), not claimed", async () => {
  const r = await executeCode(
    { code: `return await platform.callTool("echo", {})` },
    { tools: () => TOOLS, call: echo, launch: plainNode },
  );
  assert.equal(r.calls[0].persisted, undefined);
});
