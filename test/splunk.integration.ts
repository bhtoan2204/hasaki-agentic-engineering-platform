import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import {
  checkSpl,
  clearSplunkCookie,
  parseSplunkCookie,
  setSplunkCookie,
  splunkSearch,
  splunkStatus,
} from "../src/integrations/splunk.ts";
import { redactPii } from "../src/integrations/redact.ts";
import { callTool, registerBuiltinTools } from "../src/agent/toolRegistry.ts";

const COOKIE =
  "_ga=GA1; splunkd_8000=SESSIONabc; splunkweb_csrf_token_8000=CSRF123; session_id_8000=s1";
let server: Server;
let alive = true;
const posts: Array<{ headers: any; form: URLSearchParams }> = [];

before(async () => {
  await migrate();
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const json = (code: number, b: unknown) => (
      res.writeHead(code, { "content-type": "application/json" }),
      res.end(JSON.stringify(b))
    );
    if (!alive || !String(req.headers.cookie ?? "").includes("splunkd_8000=SESSIONabc"))
      return (res.writeHead(303, { location: "/en-US/account/login" }), res.end());
    if (
      req.method === "GET" &&
      url.pathname === "/en-US/splunkd/__raw/services/authentication/current-context"
    )
      return json(200, { entry: [{ content: { username: "dev@hasaki.vn", roles: ["user"] } }] });
    if (req.method === "POST" && url.pathname === "/en-US/splunkd/__raw/services/search/jobs") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        posts.push({ headers: req.headers, form: new URLSearchParams(body) });
        if (req.headers["x-splunk-form-key"] !== "CSRF123")
          return json(401, { messages: [{ type: "ERROR", text: "csrf" }] });
        json(200, {
          results: [
            {
              _time: "2026-11-05T07:00:00Z",
              _raw: "ERROR HSK-T123 phone=0912345678 email=nguyen.a@gmail.com card=4111 1111 1111 1111",
              _cd: "1:2",
              _bkt: "x",
              host: "pay-1",
            },
            {
              _time: "2026-11-05T07:00:01Z",
              _raw: "order 260512345678 refund ok Authorization: Bearer abcdefghijklmnopqrstuvwx",
              host: "pay-2",
            },
          ],
        });
      });
      return;
    }
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  config.splunk.baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  server.close();
  await pool.end();
});

test("parseSplunkCookie: Cookie header, `Cookie:` line and Copy-as-cURL; both session and csrf cookies required", () => {
  assert.deepEqual(parseSplunkCookie(COOKIE), { cookie: COOKIE, formKey: "CSRF123" });
  assert.equal(parseSplunkCookie(`Cookie: ${COOKIE}`).formKey, "CSRF123");
  assert.equal(
    parseSplunkCookie(
      `curl 'https://siem.hasaki.work/en-US/app' -H 'accept: */*' -H 'cookie: ${COOKIE}' --compressed`,
    ).cookie,
    COOKIE,
  );
  assert.throws(() => parseSplunkCookie("splunkweb_csrf_token_8000=x"), /splunkd_/);
  assert.throws(() => parseSplunkCookie("splunkd_8000=x"), /csrf/);
});

test("checkSpl: write/exfiltration commands refused anywhere, plain terms get `search`, allowed indexes enforced", () => {
  assert.equal(checkSpl('index=pay "HSK-T123" | head 10'), 'search index=pay "HSK-T123" | head 10');
  assert.equal(
    checkSpl("| tstats count where index=pay by host"),
    "| tstats count where index=pay by host",
  );
  for (const bad of [
    "index=pay | delete",
    "index=pay | outputlookup x.csv",
    "| rest /services/authentication/users",
    "index=pay [| rest /x | fields a]",
    "index=pay | sendemail to=a@b.c",
    "index=pay | collect index=x",
    'index=pay | map search="x"',
  ])
    assert.throws(() => checkSpl(bad), /không được phép/, bad);
  config.splunk.allowedIndexes = ["pay", "oms"];
  try {
    assert.ok(checkSpl("index=pay error"));
    assert.throws(() => checkSpl("error"), /index=/);
    assert.throws(() => checkSpl("index=pay OR index=hr"), /hr/);
  } finally {
    config.splunk.allowedIndexes = [];
  }
});

test("redactPii masks e-mails, VN phones, valid card numbers and credentials; keeps order codes", () => {
  const r = redactPii(
    "phone=0912345678 +84912345678 email=nguyen.a@gmail.com card=4111111111111111 order=260512345678 token=abcdefgh1234",
  );
  assert.doesNotMatch(r, /0912345678|nguyen\.a@|4111111111111111|abcdefgh1234/);
  assert.match(r, /n\*\*\*@gmail\.com/);
  assert.match(r, /\*\*\*\*1111/);
  assert.match(r, /260512345678/, "12-digit order code is not a phone or a Luhn-valid card here");
});

test("session is validated before saving; search sends the CSRF key, caps the window and masks results; expiry is detected", async () => {
  await clearSplunkCookie();
  registerBuiltinTools();
  const ctx = { runId: 0, allowedRepositories: [], mode: "analysis" as const };
  assert.match(
    String((await callTool("splunk.search", { query: "index=pay x" }, ctx)).error),
    /not connected/,
  );
  await assert.rejects(
    setSplunkCookie("splunkd_8000=WRONG; splunkweb_csrf_token_8000=CSRF123"),
    /hết hạn|không hợp lệ/,
  );

  const st = await setSplunkCookie(COOKIE);
  assert.equal(st.connected, true);
  assert.equal(st.user, "dev@hasaki.vn");

  const r = await callTool(
    "splunk.search",
    { query: 'index=pay "HSK-T123"', since_minutes: 999999, max_results: 99999 },
    ctx,
  );
  assert.equal(r.ok, true, String(r.error));
  const res: any = r.result;
  const sent = posts.at(-1)!;
  assert.equal(sent.headers["x-splunk-form-key"], "CSRF123");
  assert.equal(sent.form.get("search"), 'search index=pay "HSK-T123"');
  assert.equal(sent.form.get("exec_mode"), "oneshot");
  assert.equal(sent.form.get("earliest_time"), `-${config.splunk.maxMinutes}m`, "window capped");
  assert.equal(sent.form.get("count"), String(config.splunk.maxResults), "result count capped");
  assert.equal(res.count, 2);
  assert.equal(res.results[0]._cd, undefined, "internal fields dropped");
  assert.doesNotMatch(res.results[0]._raw, /0912345678|nguyen\.a@gmail|4111 1111 1111 1111/);
  assert.match(res.results[0]._raw, /HSK-T123/);
  assert.match(res.results[1]._raw, /Bearer \*\*\*/);

  assert.equal((await callTool("splunk.search", { query: "index=pay | delete" }, ctx)).ok, false);

  alive = false; // Splunk Web session timed out
  await assert.rejects(splunkSearch({ query: "index=pay x" }), /hết hạn/);
  assert.equal((await splunkStatus()).expired, true);
  assert.match(
    String((await callTool("splunk.search", { query: "index=pay x" }, ctx)).error),
    /expired/,
  );
  alive = true;
  assert.equal((await clearSplunkCookie()).connected, false);
});
