import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { pool, q } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createUser } from "../src/auth/users.ts";
import { setDayKind } from "../src/timesheet.ts";

let userId = 0;
let otherId = 0;
before(async () => {
  await migrate();
  userId = (
    await createUser({ username: "ts-override-a", password: "timesheet-pass", role: "member" })
  ).id;
  otherId = (
    await createUser({ username: "ts-override-b", password: "timesheet-pass", role: "member" })
  ).id;
});
after(() => pool.end());

const stored = async (id: number) =>
  q<{ d: string; kind: string }>(
    pool,
    "SELECT to_char(work_date, 'YYYY-MM-DD') AS d, kind FROM timesheet_day_overrides WHERE user_id = $1 ORDER BY work_date",
    [id],
  );

test("a day correction is stored per user, replaced by a new choice and removed by auto", async () => {
  assert.deepEqual(await setDayKind(userId, "2026-11-23", "full"), {
    date: "2026-11-23",
    kind: "full",
  });
  assert.deepEqual(await stored(userId), [{ d: "2026-11-23", kind: "full" }]);
  await setDayKind(userId, "2026-11-23", "half_leave");
  assert.deepEqual(await stored(userId), [{ d: "2026-11-23", kind: "half_leave" }]);
  await setDayKind(otherId, "2026-11-23", "full");
  assert.deepEqual(
    await stored(userId),
    [{ d: "2026-11-23", kind: "half_leave" }],
    "another user's choice is separate",
  );
  assert.deepEqual(await setDayKind(userId, "2026-11-23", "auto"), {
    date: "2026-11-23",
    kind: "auto",
  });
  assert.deepEqual(await stored(userId), []);
  assert.deepEqual(await stored(otherId), [{ d: "2026-11-23", kind: "full" }]);
});

test("invalid dates and kinds are refused", async () => {
  for (const [date, kind] of [
    ["2026-13-01", "full"],
    ["2026-02-30", "full"],
    ["23/11/2026", "full"],
    [null, "full"],
    ["2026-11-23", "missing_punch"],
    ["2026-11-23", "morning"],
    ["2026-11-23", undefined],
  ])
    await assert.rejects(setDayKind(userId, date, kind), /invalid/, `${date} ${kind}`);
  assert.deepEqual(await stored(userId), []);
});
