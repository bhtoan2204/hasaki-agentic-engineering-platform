import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { routeTurnIntelligent } from "../src/chat/routing.ts";
import { routeTurn } from "../src/chat/policy.ts";
import { mayFallback } from "../src/chat/admission.ts";
import { chatFailure } from "../src/chat/failures.ts";

describe("chat intelligent routing", () => {
  it("generic technical questions stay on DIRECT_ANSWER", () => {
    const d = routeTurnIntelligent("ASK", "What is a fencing token?", []);
    assert.equal(d.route, "DIRECT_ANSWER");
    assert.equal(d.path, "direct");
  });

  it("payment provider inventory triggers repository query (not regex-only code words)", () => {
    const d = routeTurnIntelligent("AUTO", "Hiện tại đang có bao nhiêu payment provider?", []);
    assert.equal(d.route, "REPOSITORY_QUERY");
    assert.equal(d.path, "tools");
    assert.equal(d.effective_mode, "ASK");
  });

  it("production error questions prefer observability under AUTO", () => {
    const d = routeTurnIntelligent("AUTO", "Xem lỗi production NullPointer trên Signoz", []);
    assert.ok(d.route === "OBSERVABILITY_INVESTIGATION" || d.effective_mode === "INVESTIGATE");
  });

  it("implementation requests resolve to DELEGATE under AUTO", () => {
    const d = routeTurnIntelligent("AUTO", "Hãy implement giúp tôi refund API và mở PR", []);
    assert.equal(d.effective_mode, "DELEGATE");
    assert.equal(d.route, "WORKFLOW_DELEGATION");
  });

  it("follow-ups reuse prior route", () => {
    const d = routeTurnIntelligent("ASK", "Còn PayPal thì sao?", [], "REPOSITORY_QUERY");
    assert.equal(d.route, "REPOSITORY_QUERY");
    assert.equal(d.source, "context");
  });

  it("legacy routeTurn still returns direct|tools", () => {
    assert.equal(routeTurn("ASK", "Xin chào", []), "direct");
    assert.equal(routeTurn("ASK", "Hiện tại đang có bao nhiêu payment provider?", []), "tools");
  });
});

describe("chat provider fallback policy", () => {
  it("permission denials must not fallback; AUTO may fall back on unavailable/quota", () => {
    assert.equal(mayFallback(chatFailure("PERMISSION_DENIED", "no"), "auto", true), false);
    assert.equal(mayFallback(chatFailure("PROVIDER_UNAVAILABLE", "down"), "manual", false), false);
    assert.equal(mayFallback(chatFailure("QUOTA_EXHAUSTED", "out"), "auto", true), true);
  });
});
