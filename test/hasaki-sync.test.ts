import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { createUser } from "../src/auth/users.ts";
import { putUserSecret } from "../src/auth/secrets.ts";
import { functionCodes, sendTaskResult, syncValues } from "../src/report/hasakiSync.ts";

after(() => pool.end());
let owner = 0;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = `${b64({ alg: "HS256" })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600, sub: 1 })}.sig`;
before(async () => {
  await migrate();
  owner = Number((await createUser({ username: "hasaki-sync-owner", password: "hasaki-sync-password", role: "member" })).id);
  await putUserSecret(owner, "hasaki_token", TOKEN);
});

test("function codes come from commit footers (distinct, in order); the task code is the fallback", () => {
  const msgs = [
    "feat(fptpay): add IPN\n\nWhy...\n\nfunc: PAY_FPT_0001, PAY_FPT_0002\ntask: HSK-ABC",
    "fix(fptpay): verify signature\n\nfunc: PAY_FPT_0002\ntask: HSK-ABC",
    "chore: bump deps",
  ];
  assert.deepEqual(functionCodes(msgs), ["PAY_FPT_0001", "PAY_FPT_0002"]);
  const wi = { code: "HSK-3K007RX3", payload: { id: 14572969, amount_of_work: 2 } };
  const withCodes = syncValues({ workItem: wi, summary: "Đã tích hợp FPT Pay.", commitMessages: msgs, prUrls: ["https://bitbucket.org/x/pr/1"] });
  assert.deepEqual(withCodes, {
    taskId: 14572969,
    amount: 2,
    unitValue: "PAY_FPT_0001, PAY_FPT_0002",
    virtualText: "Đã tích hợp FPT Pay.\nPR: https://bitbucket.org/x/pr/1",
  });
  const noCodes = syncValues({ workItem: { code: "HSK-3K007RX3", payload: { id: 14572969, amount_of_work: null } }, summary: "x", commitMessages: ["chore: y"], prUrls: [] });
  assert.equal((noCodes as any).unitValue, "HSK-3K007RX3", "no function code: the task code");
  assert.equal((noCodes as any).amount, 1, "task without amount_of_work: 1");
  assert.deepEqual(syncValues({ workItem: { code: "X", payload: {} }, summary: "x", commitMessages: [], prUrls: [] }), { skipped: "work item is not a Hasaki Work task" });
});

test("the three Hasaki Work calls go out in order with the owner's token; a failure stops the rest", async () => {
  const sent: Array<{ url: string; auth: string | null; type: string | null; body: any }> = [];
  const real = globalThis.fetch;
  let failAt = -1;
  globalThis.fetch = (async (url: any, init: any) => {
    const body = init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(init?.body ?? "null");
    sent.push({ url: String(url), auth: init?.headers?.Authorization ?? null, type: init?.headers?.["Content-Type"] ?? null, body });
    const ok = sent.length - 1 !== failAt;
    return new Response(JSON.stringify(ok ? { success: true } : { message: "boom" }), { status: ok ? 200 : 500, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const v = { taskId: 14572969, amount: 1, unitValue: "PAY_FPT_0001", virtualText: "Kết quả" };
    const r = await sendTaskResult(owner, v);
    assert.equal(r.ok, true);
    assert.deepEqual(r.calls.map((c) => c.field), ["unit_amount_of_work", "unit_value", "data"]);
    assert.ok(sent.every((s) => s.url === "https://wshr.hasaki.vn/api/hr/projects/mass-update-field-task-input"));
    assert.ok(sent.every((s) => s.auth === `Bearer ${TOKEN}`), "the run owner's own token");
    assert.deepEqual(sent[0].body, { id: 14572969, field: "unit_amount_of_work", value: 1 });
    assert.deepEqual(sent[1].body, { id: 14572969, field: "unit_value", value: "PAY_FPT_0001" });
    assert.equal(sent[2].type, null, "multipart: fetch sets the boundary header itself");
    assert.deepEqual(sent[2].body, {
      id: "14572969",
      field: "data",
      "value[configs][virtual_text]": "Kết quả",
      "extra_fields[efficiency]": "",
      "extra_fields[efficiency_metrics]": "",
      "extra_fields[unit_value]": "PAY_FPT_0001",
      "extra_fields[amount_of_work]": "1",
    });
    sent.length = 0;
    failAt = 1;
    const failed = await sendTaskResult(owner, v);
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.calls.map((c) => [c.field, c.ok]), [["unit_amount_of_work", true], ["unit_value", false]]);
    assert.equal(sent.length, 2, "the multipart call is not sent after a failure");
  } finally {
    globalThis.fetch = real;
  }
});
