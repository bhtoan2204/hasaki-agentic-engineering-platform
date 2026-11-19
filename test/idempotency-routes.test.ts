import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { needsIdempotency } from "../src/http/idempotency.ts";

describe("needsIdempotency", () => {
  test("returns true for valid POST requests to idempotent routes", () => {
    const validPostPaths = [
      "/api/work-items",
      "/api/work-items/import",
      "/api/work-items/1/runs",
      "/api/work-items/999/runs",
      "/api/work-items/42/analyze",
      "/api/runs",
      "/api/runs/10/steps/compile/evidence",
      "/api/runs/123/steps/step_42-test/evidence",
      "/api/work/pick/1",
      "/api/work/pick/500",
      "/api/prod-errors/scan",
      "/api/prod-errors/0123456789abcdef0123/investigate",
      "/api/prod-errors/ffffffffffffffffffff/investigate",
      "/api/chat/conversations",
      "/api/chat/conversations/1/messages",
      "/api/chat/conversations/999/messages",
      "/api/chat/conversations/5/delegation/execute",
      "/api/chat/turns/12/regenerate",
    ];

    for (const path of validPostPaths) {
      assert.equal(needsIdempotency("POST", path), true, `expected true for POST ${path}`);
    }
  });

  test("returns false for non-POST HTTP methods on idempotent routes", () => {
    const path = "/api/runs";
    const nonPostMethods = ["GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "post"];
    for (const method of nonPostMethods) {
      assert.equal(needsIdempotency(method, path), false, `expected false for ${method} ${path}`);
    }
  });

  test("returns false for non-matching subpaths and invalid parameter shapes", () => {
    const nonMatching = [
      // work-items must have numeric ID
      "/api/work-items/abc/runs",
      "/api/work-items/123/unknown",
      "/api/work-items/123",
      // runs subpaths
      "/api/runs/123",
      "/api/runs/10/steps/compile/unknown",
      // prod-errors investigate requires exactly 20 lowercase hex chars
      "/api/prod-errors/12345/investigate", // too short
      "/api/prod-errors/0123456789abcdef01234/investigate", // 21 chars, too long
      "/api/prod-errors/0123456789ABCDEF0123/investigate", // uppercase hex not accepted
      // chat turns regenerate requires numeric ID
      "/api/chat/turns/abc/regenerate",
      // other non-matching routes
      "/api/users",
      "/api/login",
      "/health",
      "/api/runs/",
      "/api/runs?param=1",
    ];

    for (const path of nonMatching) {
      assert.equal(needsIdempotency("POST", path), false, `expected false for POST ${path}`);
    }
  });

  test("returns false for empty values and whitespace", () => {
    assert.equal(needsIdempotency("", ""), false);
    assert.equal(needsIdempotency("POST", ""), false);
    assert.equal(needsIdempotency("", "/api/runs"), false);
    assert.equal(needsIdempotency("POST", "   "), false);
  });
});
