import { test } from "node:test";
import assert from "node:assert/strict";
import {
  legacyProductionRoute,
  trustedProductionReturn,
} from "../web/src/pages/prodErrors/routes.ts";

test("legacy production analytics routes retain encoded filters and service returns", () => {
  const query =
    "view=service&namespace=oms&service=api&return_query=from%3D2026-11-01%26timezone%3DUTC";
  assert.equal(legacyProductionRoute("/insights/health", query), `/prod-errors/service?${query}`);
  assert.equal(
    legacyProductionRoute("/insights/health", "severity=high"),
    "/prod-errors/overview?severity=high",
  );
  assert.equal(legacyProductionRoute("/insights/evaluation"), null);
  assert.equal(legacyProductionRoute("/insights/usage"), null);
});
test("incident return navigation only accepts trusted production paths", () => {
  for (const value of [
    null,
    "https://evil.test",
    "//evil.test",
    "/prod-errors/../account",
    "/prod-errors\\evil",
    "/insights/quality",
    "/prod-errors#//evil",
  ]) {
    assert.equal(trustedProductionReturn(value), "/prod-errors/incidents");
  }
  assert.equal(
    trustedProductionReturn("/prod-errors/service?service=oms&from=2026-11-01"),
    "/prod-errors/service?service=oms&from=2026-11-01",
  );
  assert.equal(
    trustedProductionReturn("/insights/health?view=service&service=oms"),
    "/prod-errors/service?view=service&service=oms",
  );
});
