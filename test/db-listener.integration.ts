import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.ts";
import { listening, subscribe } from "../src/db/listener.ts";

after(() => pool.end());

const until = async (pred: () => boolean, ms = 8000) => {
  for (const end = Date.now() + ms; !pred(); await new Promise((r) => setTimeout(r, 20)))
    if (Date.now() > end) throw new Error("timed out");
};

test("one real connection: per-channel delivery, re-LISTEN and one onReconnect per channel after a terminated backend", async () => {
  const got: string[] = [];
  const reconnects: string[] = [];
  const subs = ["orbit_test_a", "orbit_test_b"].map((ch) =>
    subscribe(
      ch,
      (p) => got.push(`${ch}:${p}`),
      () => reconnects.push(ch),
    ),
  );
  await Promise.all(subs.map((s) => s.ready));
  const backends = async () =>
    (
      await pool.query(
        "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'LISTEN orbit_test_%'",
      )
    ).rows.map((r) => r.pid as number);
  assert.equal((await backends()).length, 1, "both channels share one connection");
  await pool.query("SELECT pg_notify('orbit_test_a', '1'), pg_notify('orbit_test_b', '2')");
  await until(() => got.length === 2);
  assert.deepEqual(got.sort(), ["orbit_test_a:1", "orbit_test_b:2"]);

  const original = console.error;
  console.error = () => {};
  try {
    await pool.query("SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid", [
      await backends(),
    ]);
    await until(() => !listening("orbit_test_a"));
    await until(() => reconnects.length === 2);
  } finally {
    console.error = original;
  }
  assert.deepEqual(reconnects.sort(), ["orbit_test_a", "orbit_test_b"]);
  await pool.query("SELECT pg_notify('orbit_test_b', '3')");
  await until(() => got.length === 3);
  assert.equal(got[2], "orbit_test_b:3");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(reconnects.length, 2, "onReconnect fired once per channel");
  await Promise.all(subs.map((s) => s()));
  assert.deepEqual(await backends(), [], "the last unsubscribe closes the connection");
});
