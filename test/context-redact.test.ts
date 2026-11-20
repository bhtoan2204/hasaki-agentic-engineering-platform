import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redactContextText, redactContextValue } from "../src/context/redact.ts";

describe("redactContextValue", () => {
  test("returns primitive values unchanged", () => {
    assert.equal(redactContextValue(null), null);
    assert.equal(redactContextValue(undefined), undefined);
    assert.equal(redactContextValue(42), 42);
    assert.equal(redactContextValue(true), true);
    assert.equal(redactContextValue(false), false);
  });

  test("converts Date instances to ISO string", () => {
    const d = new Date("2026-11-20T00:00:00.000Z");
    assert.equal(redactContextValue(d), "2026-11-20T00:00:00.000Z");
  });

  test("masks sensitive keys in objects case-insensitively", () => {
    const sensitiveObj = {
      password: "plain-password",
      Passwd: "another-password",
      SECRET: "top-secret",
      api_key: "key-12345",
      apiKey: "key-67890",
      "api-key": "key-dash",
      access_token: "token-abc",
      accessToken: "token-def",
      refresh_token: "refresh-xyz",
      refreshToken: "refresh-123",
      auth_token: "auth-456",
      session_token: "session-789",
      sessionToken: "session-000",
      client_secret: "client-sec",
      clientSecret: "client-sec-camel",
      username: "alice",
      age: 30,
    };

    const redacted = redactContextValue(sensitiveObj);
    assert.equal(redacted.password, "[redacted]");
    assert.equal(redacted.Passwd, "[redacted]");
    assert.equal(redacted.SECRET, "[redacted]");
    assert.equal(redacted.api_key, "[redacted]");
    assert.equal(redacted.apiKey, "[redacted]");
    assert.equal(redacted["api-key"], "[redacted]");
    assert.equal(redacted.access_token, "[redacted]");
    assert.equal(redacted.accessToken, "[redacted]");
    assert.equal(redacted.refresh_token, "[redacted]");
    assert.equal(redacted.refreshToken, "[redacted]");
    assert.equal(redacted.auth_token, "[redacted]");
    assert.equal(redacted.session_token, "[redacted]");
    assert.equal(redacted.sessionToken, "[redacted]");
    assert.equal(redacted.client_secret, "[redacted]");
    assert.equal(redacted.clientSecret, "[redacted]");
    assert.equal(redacted.username, "alice");
    assert.equal(redacted.age, 30);
  });

  test("recursively redacts arrays and nested objects", () => {
    const nested = {
      user: "bob",
      tokens: [{ type: "session", secret: "supersecret" }],
      meta: {
        config: {
          apiKey: "my-key",
          active: true,
        },
      },
    };
    const result = redactContextValue(nested);
    assert.equal(result.user, "bob");
    assert.equal(result.tokens[0].secret, "[redacted]");
    assert.equal(result.tokens[0].type, "session");
    assert.equal(result.meta.config.apiKey, "[redacted]");
    assert.equal(result.meta.config.active, true);
  });

  test("handles empty objects and empty arrays", () => {
    assert.deepEqual(redactContextValue({}), {});
    assert.deepEqual(redactContextValue([]), []);
  });

  test("bounds deeply nested content when depth > 30", () => {
    let deep: object = { value: "leaf" };
    for (let i = 0; i < 35; i++) {
      deep = { child: deep };
    }
    const result = redactContextValue(deep);
    let cur = result;
    for (let i = 0; i < 30; i++) {
      cur = cur.child;
    }
    assert.equal(cur.child, "[bounded nested content]");
  });
});

describe("redactContextText", () => {
  test("redacts sk-, rt-, and sess- tokens in free text", () => {
    const text =
      "Connected with sk-ant-api03-secret123456 and rt-1234567890abcdef and sess-1234567890abcdef successfully.";
    const result = redactContextText(text);
    assert.equal(result, "Connected with [redacted] and [redacted] and [redacted] successfully.");
  });

  test("redacts Bearer credentials and secrets via redactSecrets", () => {
    const text = "Authorization: Bearer mySecretTokenValue12345678";
    const result = redactContextText(text);
    assert.equal(result, "Authorization: Bearer ***");
  });

  test("parses JSON-encoded object strings, redacts sensitive keys, and re-serializes", () => {
    const jsonStr = JSON.stringify({
      password: "secret_password",
      username: "alice",
      token: "sk-token12345678",
    });
    const result = redactContextText(jsonStr);
    const parsed = JSON.parse(result);
    assert.equal(parsed.password, "[redacted]");
    assert.equal(parsed.username, "alice");
    assert.equal(parsed.token, "[redacted]");
  });

  test("parses JSON-encoded array strings and redacts elements", () => {
    const jsonStr = JSON.stringify([
      { secret: "hidden", value: 1 },
      { secret: "also-hidden", value: 2 },
    ]);
    const result = redactContextText(jsonStr);
    const parsed = JSON.parse(result);
    assert.equal(parsed[0].secret, "[redacted]");
    assert.equal(parsed[0].value, 1);
    assert.equal(parsed[1].secret, "[redacted]");
    assert.equal(parsed[1].value, 2);
  });

  test("falls back to plain text redaction for malformed JSON starting with { or [", () => {
    const badJson1 = "{ not real json sk-1234567890abcdef }";
    const result1 = redactContextText(badJson1);
    assert.equal(result1, "{ not real json [redacted] }");

    const badJson2 = "[ not valid JSON sess-1234567890abcdef ]";
    const result2 = redactContextText(badJson2);
    assert.equal(result2, "[ not valid JSON [redacted] ]");
  });

  test("handles empty strings and whitespace", () => {
    assert.equal(redactContextText(""), "");
    assert.equal(redactContextText("   "), "   ");
  });

  test("preserves non-sensitive strings without modifications", () => {
    const normal = "This is a regular log line without any credentials or tokens.";
    assert.equal(redactContextText(normal), normal);
  });
});
