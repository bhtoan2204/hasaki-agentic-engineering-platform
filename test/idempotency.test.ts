import { createHash } from "node:crypto";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { pool, one } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createUser } from "../src/auth/users.ts";
import { claimIdempotency, pruneIdempotency } from "../src/http/idempotency.ts";

before(() => migrate());
after(() => pool.end());

test("the day-old prune keeps an in-progress key and drops a finished one", async () => {
  const user = await createUser({
    username: "idem-user",
    password: "idem-password",
    role: "member",
  });
  const hash = createHash("sha256")
    .update(`/api/runs\n${JSON.stringify(null)}`)
    .digest("hex");
  await pool.query(
    `INSERT INTO http_idempotency (actor_id, key, route, request_hash, status, response, created_at) VALUES
      ($1, 'inprogresskey', '/api/runs', $2, NULL, NULL, now() - interval '2 days'),
      ($1, 'finishedkey01', '/api/runs', $2, 201, '{"id":1}', now() - interval '2 days')`,
    [user.id, hash],
  );
  assert.equal(await pruneIdempotency(), 1);
  const left = await one(pool, "SELECT key, status FROM http_idempotency WHERE actor_id = $1", [
    user.id,
  ]);
  assert.equal(left.key, "inprogresskey");
  assert.equal(left.status, null);
  const again = await claimIdempotency(user.id, "inprogresskey", "/api/runs", null);
  assert.equal(again.kind, "conflict");
  assert.equal(again.status, 409);
});
