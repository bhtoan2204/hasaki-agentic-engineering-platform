import { test } from "node:test";
import assert from "node:assert/strict";
import { REDACTED, scrubResult, scrubText, scrubValue } from "../src/sharing/scrub.ts";

// Realistic shapes, assembled at runtime so no literal credential sits in the repository.
const ANTHROPIC = "sk-ant-api03-" + "Zx9".repeat(12);
const OPENAI = "sk-proj-" + "Ab3dE".repeat(6);
const AWS = "AKIA" + "IOSFODNN7EXAMPLE";
const GITHUB = "ghp_" + "a1B2c3D4e5".repeat(4);
const SLACK = "xoxb-" + "1234567890-abcdefghij";
const GOOGLE = "AIza" + "SyD-1234567890abcdefghijklmnopqrstu";
const JWT = "eyJhbGciOiJIUzI1NiJ9." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0." + "dozjgNryP4J3jVmNHl0w5N";
const PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7\nabc\n-----END RSA PRIVATE KEY-----";

const SAMPLES: Array<[string, string]> = [
  ["anthropic key", `calling with key ${ANTHROPIC} failed`],
  ["openai key", `OPENAI=${OPENAI}`],
  ["aws key id", `aws_access_key_id ${AWS}`],
  ["github token", `git push https://${GITHUB}@github.com/x/y`],
  ["slack token", `slack ${SLACK}`],
  ["google key", `maps?key=${GOOGLE}`],
  ["bearer token", "Authorization: Bearer " + "abcDEF123456ghiJKL789"],
  ["jwt", `token ${JWT}`],
  ["postgres url", "dial postgres://oms_app:" + "S3cretPassw0rd" + "@10.0.3.17:5432/oms"],
  ["mongodb srv", "mongodb+srv://svc:" + "hunter2hunter2" + "@cluster0.mongodb.net/db"],
  ["redis password only", "redis://:" + "r3d1sPassw0rd" + "@cache:6379/0"],
  ["ado connection string", "Server=db;User Id=sa;Password=" + "Pa55word!x;" + "Database=oms"],
  ["json password", '{"password": "' + "correct-horse-battery" + '"}'],
  ["private key", PEM],
];

test("scrub: every credential sample is removed, whatever the surrounding text", () => {
  const secrets = [
    ANTHROPIC,
    OPENAI,
    AWS,
    GITHUB,
    SLACK,
    GOOGLE,
    "abcDEF123456ghiJKL789",
    JWT,
    "S3cretPassw0rd",
    "hunter2hunter2",
    "r3d1sPassw0rd",
    "Pa55word!x",
    "correct-horse-battery",
    "MIIEowIBAAKCAQEA7",
  ];
  for (const [name, text] of SAMPLES) {
    const out = scrubText(text);
    for (const s of secrets) assert.ok(!out.includes(s), `${name}: "${out}" still holds a secret`);
  }
});

test("scrub: customer data is masked (e-mail, VN phone numbers, card numbers, national ids)", () => {
  const out = scrubText(
    "customer nguyen.van.a@gmail.com phone 0912345678 / +84987654321 paid with 4111 1111 1111 1111, CCCD: 079203001234",
  );
  for (const pii of [
    "nguyen.van.a@",
    "0912345678",
    "84987654321",
    "4111 1111 1111 1111",
    "079203001234",
  ])
    assert.ok(!out.includes(pii), `${pii} in "${out}"`);
});

test("scrub keeps what diagnosis needs: request and trace ids, IPs, commit SHAs, order ids, numbers", () => {
  const text =
    "request_id=7f3c9a2e-41d2-4b6a-9e0f-2c1d3b4a5e6f trace_id=4bf92f3577b34da6a3ce929d0e0e4736 host 10.0.3.17 " +
    "at commit 9fceb02d0ae598e95dc970b74767f19372d61af8: order 1029384 not found after 3000ms";
  assert.equal(scrubText(text), text);
  const report = {
    findings: [{ title: "timeout", count: 12, ok: true, lines: [10, 20], at: null }],
  };
  assert.deepEqual(scrubValue(report), report);
});

test("scrub: a field named like a credential is replaced whole, at any depth; other fields keep their text", () => {
  const out = scrubValue({
    evidence: [
      { config: { password: "x", "api-key": "short", accessToken: "abc", dsn: "anything" } },
    ],
    title: "token refresh fails",
    tokens: 1200,
  }) as { evidence: Array<{ config: Record<string, string> }>; title: string; tokens: number };
  assert.deepEqual(out.evidence[0].config, {
    password: REDACTED,
    "api-key": REDACTED,
    accessToken: REDACTED,
    dsn: REDACTED,
  });
  assert.equal(out.title, "token refresh fails");
  assert.equal(out.tokens, 1200);
});

test("scrub is idempotent: scrubbing a scrubbed snapshot changes nothing", () => {
  const snapshot = { text: SAMPLES.map(([, t]) => t).join("\n") + " a@b.vn 0912345678" };
  const once = scrubValue(snapshot);
  assert.deepEqual(scrubValue(once), once);
});

test("N6: object keys containing secrets or PII are scrubbed", () => {
  const out = scrubValue({
    ["nguyen.van.a@gmail.com"]: "user",
    [ANTHROPIC]: "leaked key in map",
    ["Authorization: Bearer " + "abcDEF123456ghiJKL789"]: 1,
    normal_key: "ok",
  }) as Record<string, unknown>;
  const text = JSON.stringify(out);
  assert.ok(!text.includes("nguyen.van.a@"));
  assert.ok(!text.includes(ANTHROPIC));
  assert.ok(!text.includes("abcDEF123456ghiJKL789"));
  assert.equal(out.normal_key, "ok");
});

test("N6: non-string credential values and unanchored credential field names are redacted without breaking token counts", () => {
  const sampleFp = ["87d5edbc", "020d1f804eb9"].join("");
  const out = scrubValue({
    token: 12345678,
    password: { value: "secret123", nested: { code: 99 } },
    api_key: [111, "abc"],
    "x-api-key": "raw-val",
    AWS_SECRET_ACCESS_KEY: "raw-aws",
    db_password: "dbp",
    dbPassword: "dbp2",
    xApiKey: "xak",
    sentry_dsn: "https://dsn.example/1",
    db_connection_string: "Server=a;Database=b",
    empty_password: "",
    null_token: null,
    tokens: 1200,
    input_tokens: 500,
    contextTokens: 24000,
    author: "alice",
    error_key: sampleFp,
  }) as Record<string, unknown>;
  assert.equal(out.token, REDACTED);
  assert.deepEqual(out.password, { value: REDACTED, nested: { code: REDACTED } });
  assert.deepEqual(out.api_key, [REDACTED, REDACTED]);
  assert.equal(out["x-api-key"], REDACTED);
  assert.equal(out.AWS_SECRET_ACCESS_KEY, REDACTED);
  assert.equal(out.db_password, REDACTED);
  assert.equal(out.dbPassword, REDACTED);
  assert.equal(out.xApiKey, REDACTED);
  assert.equal(out.sentry_dsn, REDACTED);
  assert.equal(out.db_connection_string, REDACTED);
  assert.equal(out.empty_password, "");
  assert.equal(out.null_token, null);
  assert.equal(out.tokens, 1200);
  assert.equal(out.input_tokens, 500);
  assert.equal(out.contextTokens, 24000);
  assert.equal(out.author, "alice");
  assert.equal(out.error_key, sampleFp);
});

test("N6: span-level redaction preserves surrounding report prose on looksSecret matches and keeps config paths", () => {
  const awsVal = ["wJalr", "XUtnFEMI_K7MDENG", "_bPxRfiCY123456"].join("");
  const dbVal = ["superSecret", "Value123"].join("");
  const report =
    "## Findings\nCheck env config:\n`AWS_SECRET_ACCESS_KEY = " +
    awsVal +
    "`\n" +
    `and \`db_secret_key=${dbVal}\`.\n` +
    "Reference path: `secretB64 = payment_client.ecom_global.secret`.\nDone.";
  const out = scrubText(report);
  assert.notEqual(out, REDACTED, "must not replace the entire report with [redacted]");
  assert.ok(out.includes("## Findings"), "keeps surrounding prose");
  assert.ok(out.includes("Reference path: `secretB64 = payment_client.ecom_global.secret`"), "keeps config path");
  assert.ok(!out.includes(awsVal));
  assert.ok(!out.includes(dbVal));
  assert.equal(scrubText(out), out, "span redaction is idempotent");
});

test("N6: scrubResult rejects snapshots whose content is completely redacted, while keeping empty-findings and partial redactions", () => {
  assert.deepEqual(scrubResult("code_assessment", { findings: [] }), { findings: [] });
  assert.deepEqual(
    scrubResult("code_assessment", {
      findings: [{ title: "timeout" }],
      config: { db_password: "secret" },
    }),
    { findings: [{ title: "timeout" }], config: { db_password: REDACTED } },
  );
  assert.throws(() => scrubResult("code_assessment", PEM), /redacted/i);
  assert.throws(() => scrubResult("code_assessment", { report: PEM }), /redacted/i);
  assert.throws(() => scrubResult("code_assessment", { password: "x", token: 1234 }), /redacted/i);
});
