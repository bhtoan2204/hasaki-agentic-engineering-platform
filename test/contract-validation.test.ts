import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contractKeys,
  missingContractKeys,
  validateOutputContract,
  isStepOutcome,
  VALID_STEP_OUTCOMES,
} from "../src/agent/contract.ts";

test("contractKeys and missingContractKeys backward compatibility", () => {
  assert.deepEqual(contractKeys("{ summary, changes: [{ repo, files }], risks, tests }"), [
    "summary",
    "changes",
    "risks",
    "tests",
  ]);
  assert.deepEqual(contractKeys("{ a, b?: string[], c?, d: { e } }"), ["a", "d"]);
  assert.deepEqual(missingContractKeys("{ a, b }", { a: 1 }), ["b"]);
  assert.deepEqual(missingContractKeys("{ summary, scope_deviations?: [] }", { summary: "x" }), []);
});

test("validateOutputContract validates required top-level fields and types", () => {
  const contract = "{ goal: string, requirements: string[], risks }";

  // Valid
  const resValid = validateOutputContract(contract, {
    goal: "Fix authentication bug",
    requirements: ["Must sanitize token", "Must reject expired credentials"],
    risks: "Low risk of breaking login flow",
  });
  assert.equal(resValid.valid, true);
  assert.deepEqual(resValid.errors, []);

  // Missing required field
  const resMissing = validateOutputContract(contract, {
    goal: "Fix bug",
    risks: "None",
  });
  assert.equal(resMissing.valid, false);
  assert.ok(resMissing.errors.some((e) => e.includes("missing required field: requirements")));

  // Wrong type: requirements not an array
  const resWrongType = validateOutputContract(contract, {
    goal: "Fix bug",
    requirements: "not an array",
    risks: "None",
  });
  assert.equal(resWrongType.valid, false);
  assert.ok(resWrongType.errors.some((e) => e.includes("requirements: expected string[]")));

  // Wrong element type in array
  const resWrongElem = validateOutputContract(contract, {
    goal: "Fix bug",
    requirements: ["req1", 123 as unknown as string],
    risks: "None",
  });
  assert.equal(resWrongElem.valid, false);
  assert.ok(resWrongElem.errors.some((e) => e.includes("requirements[1]: expected string")));
});

test("validateOutputContract handles nested objects and arrays of objects", () => {
  const contract = "{ summary, changes: [{ repo, files, description }], risks, tests }";

  const validOutput = {
    summary: "Implemented fix",
    changes: [
      { repo: "core", files: ["auth.go"], description: "Added check" },
      { repo: "web", files: ["app.ts"], description: "Updated UI" },
    ],
    risks: ["Migration failure"],
    tests: "Run go test ./...",
  };
  assert.equal(validateOutputContract(contract, validOutput).valid, true);

  // Missing nested field in changes[1]
  const invalidOutput = {
    summary: "Implemented fix",
    changes: [
      { repo: "core", files: ["auth.go"], description: "Added check" },
      { repo: "web", files: ["app.ts"] }, // missing description
    ],
    risks: ["None"],
    tests: "go test",
  };
  const res = validateOutputContract(contract, invalidOutput);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('changes[1]: missing required field "description"')));
});

test("validateOutputContract handles dynamic map objects [repo]", () => {
  const contract = "{ summary, pull_requests: { [repo]: { title, summary, decisions } }, verification }";

  const validOutput = {
    summary: "Complete implementation",
    pull_requests: {
      "repo-a": {
        title: "feat: add feature A",
        summary: "Implemented feature A",
        decisions: [{ title: "D1", detail: "Detail 1" }],
      },
    },
    verification: "PASS",
  };
  assert.equal(validateOutputContract(contract, validOutput).valid, true);

  // Missing required field in map entry
  const invalidOutput = {
    summary: "Complete implementation",
    pull_requests: {
      "repo-a": {
        title: "feat: add feature A",
        // missing summary and decisions
      },
    },
    verification: "PASS",
  };
  const res = validateOutputContract(contract, invalidOutput);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('pull_requests["repo-a"]: missing required field "summary"')));
});

test("validateOutputContract validates enums and optional fields", () => {
  const contract =
    '{ verdict: "PASS" | "FAIL" | "BLOCKED", findings: [{ severity: "high"|"medium"|"low", file, line, explanation, evidence }], summary, blocked_reason? }';

  const validPass = {
    verdict: "PASS",
    findings: [],
    summary: "Verification clean",
  };
  assert.equal(validateOutputContract(contract, validPass).valid, true);

  const validBlocked = {
    verdict: "BLOCKED",
    findings: [
      {
        severity: "high",
        file: "auth.ts",
        line: 42,
        explanation: "Missing credential checks",
        evidence: "Line 42 returns true unconditionally",
      },
    ],
    summary: "Blocked due to security vulnerability",
    blocked_reason: "High severity finding in auth.ts",
  };
  assert.equal(validateOutputContract(contract, validBlocked).valid, true);

  // Invalid enum value for verdict
  const invalidVerdict = {
    verdict: "UNKNOWN",
    findings: [],
    summary: "Done",
  };
  const resVerdict = validateOutputContract(contract, invalidVerdict);
  assert.equal(resVerdict.valid, false);
  assert.ok(resVerdict.errors.some((e) => e.includes('verdict: expected one of ["PASS", "FAIL", "BLOCKED"]')));

  // Invalid enum value for severity in findings[0]
  const invalidSeverity = {
    verdict: "FAIL",
    findings: [
      {
        severity: "critical", // not high/medium/low
        file: "auth.ts",
        line: 1,
        explanation: "err",
        evidence: "ev",
      },
    ],
    summary: "Failed",
  };
  const resSeverity = validateOutputContract(contract, invalidSeverity);
  assert.equal(resSeverity.valid, false);
  assert.ok(resSeverity.errors.some((e) => e.includes('findings[0].severity: expected one of ["high", "medium", "low"]')));
});

test("validateOutputContract checks outcome enum when outcome field is provided", () => {
  assert.deepEqual(VALID_STEP_OUTCOMES, ["IMPLEMENTED", "NO_CHANGE_REQUIRED", "BLOCKED", "FAILED"]);
  assert.equal(isStepOutcome("IMPLEMENTED"), true);
  assert.equal(isStepOutcome("NO_CHANGE_REQUIRED"), true);
  assert.equal(isStepOutcome("BLOCKED"), true);
  assert.equal(isStepOutcome("FAILED"), true);
  assert.equal(isStepOutcome("COMPLETED"), false);

  const contract = "{ summary }";
  const validWithOutcome = {
    summary: "No change needed after audit",
    outcome: "NO_CHANGE_REQUIRED",
  };
  assert.equal(validateOutputContract(contract, validWithOutcome).valid, true);

  const invalidOutcome = {
    summary: "Done",
    outcome: "INVALID_STATUS",
  };
  const res = validateOutputContract(contract, invalidOutcome);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes("invalid outcome value")));
});
