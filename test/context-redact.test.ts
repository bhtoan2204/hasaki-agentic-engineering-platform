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

    assert.deepEqual(redactContextValue(sensitiveObj), {
      password: "[redacted]",
      Passwd: "[redacted]",
      SECRET: "[redacted]",
      api_key: "[redacted]",
      apiKey: "[redacted]",
      "api-key": "[redacted]",
      access_token: "[redacted]",
      accessToken: "[redacted]",
      refresh_token: "[redacted]",
      refreshToken: "[redacted]",
      auth_token: "[redacted]",
      session_token: "[redacted]",
      sessionToken: "[redacted]",
      client_secret: "[redacted]",
      clientSecret: "[redacted]",
      username: "alice",
      age: 30,
    });
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
    assert.deepEqual(redactContextValue(nested), {
      user: "bob",
      tokens: [{ type: "session", secret: "[redacted]" }],
      meta: { config: { apiKey: "[redacted]", active: true } },
    });
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
    let expected: unknown = "[bounded nested content]";
    for (let i = 0; i < 31; i++) {
      expected = { child: expected };
    }
    assert.deepEqual(redactContextValue(deep), expected);
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
