import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KEY_VERSION,
  KeyError,
  bugHuntKey,
  canonicalJson,
  codeAssessmentKey,
  errorKeyOf,
  modelOf,
  normalizeFocus,
  reposOf,
  rubricHash,
  runtimeRcaKey,
  type BugHuntKeyInput,
  type CodeAssessmentKeyInput,
  type RuntimeRcaKeyInput,
} from "../src/sharing/key.ts";
import { fingerprint, signatureOf } from "../src/prodErrors/scan.ts";

const SCOPE = "0b6f1a52-3c1e-4c8a-9d57-1f2a3b4c5d6e";
const OTHER_SCOPE = "9a1c7f3e-2b4d-4e6f-8a0b-1c2d3e4f5a6b";
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const RUBRIC = rubricHash({
  instructions: "Assess the repository.",
  outputContract: "{ findings: [] }",
  pinned: [{ key: "skill.ext.review", version: 3 }],
});
const MODEL = modelOf("claude", "claude-opus-5-5");

const rca = (o: Partial<RuntimeRcaKeyInput> = {}) =>
  runtimeRcaKey({
    scope: SCOPE,
    errorKey: "87d5edbc020d1f804eb9",
    workflow: { key: "production-incident-investigation", version: 17 },
    contract: "unified-rca/v1",
    rubricHash: RUBRIC,
    model: MODEL,
    ...o,
  });
const hunt = (o: Partial<BugHuntKeyInput> = {}) =>
  bugHuntKey({
    scope: SCOPE,
    errorKey: "87d5edbc020d1f804eb9",
    repos: [
      { repo: "oms-api", commit: A },
      { repo: "payment", commit: B },
    ],
    workflow: { key: "production-bug-hunt", version: 4 },
    rubricHash: RUBRIC,
    model: MODEL,
    ...o,
  });
const assess = (o: Partial<CodeAssessmentKeyInput> = {}) =>
  codeAssessmentKey({
    scope: SCOPE,
    repos: [
      { repo: "oms-api", commit: A },
      { repo: "payment", commit: B },
    ],
    focus: "",
    workflow: { key: "codebase-assessment", version: 12 },
    rubricHash: RUBRIC,
    model: MODEL,
    ...o,
  });

// ---- the plan's production error examples (docs/shared-results/PLAN.md, section 3.2): raw message → key
test("production errors: the plan's table of raw messages, signatures and error keys, computed by the real code", () => {
  const key = (message: string, service = "oms-api", level = "error") =>
    fingerprint("oms", service, level, signatureOf(message));
  assert.equal(signatureOf("order 1029384 not found"), "order <n> not found");
  assert.equal(key("order 1029384 not found"), "87d5edbc020d1f804eb9");
  assert.equal(
    key("order 77 not found"),
    "87d5edbc020d1f804eb9",
    "another occurrence: the same key",
  );
  assert.equal(
    key("order 77 not found", "oms-worker"),
    "b816e546e9607cea8ffb",
    "the service is part of it",
  );
  assert.equal(
    key("order 77 not found", "oms-api", "warn"),
    "71b3c344d5a2d9cfb8bb",
    "the level is part of it",
  );
  assert.equal(
    signatureOf("payment 9f8e7d6c5b4a39281706f5e4d3c2b1a0 failed: timeout after 3000ms"),
    "payment <hex> failed: timeout after <n>",
  );
  assert.equal(
    key("payment 9f8e7d6c5b4a39281706f5e4d3c2b1a0 failed: timeout after 3000ms"),
    "b6d82658b3e6f4cbe788",
  );
  assert.equal(
    signatureOf("user 3fa85f64-5717-4562-b3fc-2c963f66afa6 locked"),
    "user <uuid> locked",
  );
  assert.equal(key("user 3fa85f64-5717-4562-b3fc-2c963f66afa6 locked"), "dde0f92d7212a5214c2c");
  assert.equal(
    signatureOf("dial tcp 10.0.3.17:5432: connect: connection refused"),
    "dial tcp <n>.<n>.<n>.<n>:<n>: connect: connection refused",
  );
  assert.equal(key("dial tcp 10.0.3.17:5432: connect: connection refused"), "5ba03fd5c483b6046ccc");
  assert.equal(
    signatureOf("failed at 2026-11-26T10:12:03Z for order A1B2"),
    "failed at <n>:<n>:<n> for order <n>",
  );
  assert.equal(key("failed at 2026-11-26T10:12:03Z for order A1B2"), "8ab515e52ae3c886efe8");
});

test("production errors: the same error on another deploy (versions, pods, request ids) keeps its error key", () => {
  const sig = (m: string) => signatureOf(m);
  assert.equal(
    sig("timeout calling payment v1.4.2 (build 8841)"),
    sig("timeout calling payment v1.4.3 (build 8907)"),
  );
  assert.equal(
    sig("pod oms-api-7c9d5f6b4-x2k9q restarted"),
    sig("pod oms-api-5d8c7f9b6-m4n7p restarted"),
  );
  assert.equal(
    sig("request 5f8e7d6c5b4a39281706f5e4d3c2b1a0 failed"),
    sig("request 0a1b2c3d4e5f60718293a4b5c6d7e8f9 failed"),
  );
  const same = (m: string) =>
    rca({ errorKey: fingerprint("oms", "oms-api", "error", signatureOf(m)) }).key;
  assert.equal(
    same("timeout calling payment v1.4.2 (build 8841)"),
    same("timeout calling payment v1.4.3 (build 8907)"),
  );
});

test("production errors: a different message is a different error and so a different key", () => {
  const k = (m: string) =>
    rca({ errorKey: fingerprint("oms", "oms-api", "error", signatureOf(m)) }).key;
  assert.notEqual(k("order <n> not found".replace("<n>", "5")), k("customer 5 not found"));
});

test("errorKeyOf accepts only a 20 character hex fingerprint", () => {
  assert.equal(errorKeyOf("87D5EDBC020D1F804EB9"), "87d5edbc020d1f804eb9");
  for (const bad of [
    "",
    "87d5edbc020d1f804eb",
    "87d5edbc020d1f804eb9a",
    "zzzzzzzzzzzzzzzzzzzz",
    " ",
  ])
    assert.throws(() => errorKeyOf(bad), KeyError, bad);
});

// ---- key shape and pinned golden values (a change here means every stored key stops matching)
test("keys are sha256 hex of the canonical parts, carry kind, version and scope, and match pinned golden values", () => {
  assert.equal(KEY_VERSION, 1);
  const k = rca();
  assert.match(k.key, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(k.parts).sort(), [
    "contract",
    "error",
    "kind",
    "model",
    "rubric",
    "scope",
    "v",
    "workflow",
  ]);
  assert.equal(k.parts.workflow, "production-incident-investigation@17");
  assert.equal(k.parts.model, "claude/claude-opus-5-5");
  assert.equal(RUBRIC, "80e2790e151d7b91e7157fa3992738b38709404d01e911ed5a7ee2da8b4e2f6b");
  assert.equal(k.key, "b5c089640fd0da0609d3f67ade904d5c4056c129c4b0fdf3471ab2f2e47725ff");
  assert.equal(hunt().key, "6c39e77f780748dcd136fc73a3e203e197cdb6dfaa9e09319f00ff7ccff115c4");
  assert.equal(
    assess({ focus: "  Refund   Flow ", workflow: { key: "codebase-assessment", version: 12 } })
      .key,
    "74b6ba2384182e85c47ca22f6025708853375d1bc5747fe593b371480d575f53",
  );
});

test("canonical JSON ignores key order and undefined, keeps array order, and refuses what it cannot represent", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [3, 1], c: null } }),
    '{"a":{"c":null,"d":[3,1]},"b":1}',
  );
  assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }));
  assert.throws(() => canonicalJson({ a: Number.NaN }), KeyError);
  assert.throws(() => canonicalJson({ a: () => 1 }), KeyError);
});

test("the scope is part of every key: the same inputs in another installation never share", () => {
  assert.notEqual(rca().key, rca({ scope: OTHER_SCOPE }).key);
  assert.notEqual(hunt().key, hunt({ scope: OTHER_SCOPE }).key);
  assert.notEqual(assess().key, assess({ scope: OTHER_SCOPE }).key);
  assert.equal(rca({ scope: SCOPE.toUpperCase() }).key, rca().key, "the id is case-insensitive");
  for (const bad of ["", "not-a-uuid", SCOPE.slice(1)])
    assert.throws(() => rca({ scope: bad }), KeyError, bad);
});

test("kinds never collide, even with the same inputs", () => {
  const keys = [rca().key, hunt().key, assess().key];
  assert.equal(new Set(keys).size, 3);
});

// ---- code assessment (plan section 3.3 examples)
test("code assessment: the repository order does not matter; the focus is normalized", () => {
  const swapped = assess({
    repos: [
      { repo: "payment", commit: B },
      { repo: "oms-api", commit: A },
    ],
  });
  assert.equal(swapped.key, assess().key);
  assert.deepEqual(assess().parts.repos, [`oms-api@${A}`, `payment@${B}`]);
  assert.equal(assess({ focus: "  Refund   Flow " }).key, assess({ focus: "refund flow" }).key);
  assert.equal(assess({ focus: "refund flow" }).parts.focus, "refund flow");
  assert.notEqual(
    assess({ focus: "refund flow" }).key,
    assess({ focus: "" }).key,
    "a focus is a different question",
  );
  assert.equal(assess({ focus: null }).key, assess({ focus: "" }).key);
  assert.equal(assess({ focus: undefined }).key, assess({ focus: "   " }).key);
});

test("normalizeFocus: case, whitespace and Unicode form (composed and decomposed Vietnamese are the same text)", () => {
  assert.equal(normalizeFocus("  Refund \n\t Flow "), "refund flow");
  assert.equal(normalizeFocus("Hoàn tiền"), normalizeFocus("Hoàn tiền".normalize("NFD")));
  assert.equal(normalizeFocus(null), "");
});

test("code assessment: partial code change. One repository at a new commit is a different key, the other staying put", () => {
  const moved = assess({
    repos: [
      { repo: "oms-api", commit: C },
      { repo: "payment", commit: B },
    ],
  });
  assert.notEqual(moved.key, assess().key);
  assert.deepEqual(moved.parts.repos, [`oms-api@${C}`, `payment@${B}`]);
  const fewer = assess({ repos: [{ repo: "oms-api", commit: A }] });
  assert.notEqual(fewer.key, assess().key, "a different set of repositories");
});

test("code assessment and bug hunt: only full commit SHAs, one per repository, valid names", () => {
  for (const bad of ["a1b2c3d", "a".repeat(39), "g".repeat(40), ""])
    assert.throws(() => assess({ repos: [{ repo: "oms-api", commit: bad }] }), KeyError, bad);
  assert.doesNotThrow(() => assess({ repos: [{ repo: "oms-api", commit: "A".repeat(40) }] }));
  assert.equal(
    assess({ repos: [{ repo: "oms-api", commit: "A".repeat(40) }] }).key,
    assess({ repos: [{ repo: "oms-api", commit: A }] }).key,
    "case-insensitive",
  );
  assert.doesNotThrow(
    () => assess({ repos: [{ repo: "oms-api", commit: "a".repeat(64) }] }),
    "sha256 repositories",
  );
  assert.throws(() => assess({ repos: [] }), KeyError);
  assert.throws(() => assess({ repos: [{ repo: "../x", commit: A }] }), KeyError);
  assert.throws(() => assess({ repos: [{ repo: "a b", commit: A }] }), KeyError);
  assert.throws(
    () =>
      reposOf([
        { repo: "oms-api", commit: A },
        { repo: "oms-api", commit: B },
      ]),
    /two different commits/,
  );
  assert.deepEqual(
    reposOf([
      { repo: "oms-api", commit: A },
      { repo: "oms-api", commit: A },
    ]),
    [`oms-api@${A}`],
    "the same repository twice at the same commit is one",
  );
});

// ---- bug hunt
test("bug hunt: the same incident at another commit is another analysis; the order of repositories is not", () => {
  assert.equal(
    hunt({
      repos: [
        { repo: "payment", commit: B },
        { repo: "oms-api", commit: A },
      ],
    }).key,
    hunt().key,
  );
  assert.notEqual(
    hunt({
      repos: [
        { repo: "oms-api", commit: C },
        { repo: "payment", commit: B },
      ],
    }).key,
    hunt().key,
  );
  assert.notEqual(hunt({ errorKey: "b816e546e9607cea8ffb" }).key, hunt().key);
});

// ---- what makes an analysis different: definition, prompt/rubric, model, contract
test("a new workflow definition version, rubric or model gives a new key (the old result goes stale, never served)", () => {
  const base = assess().key;
  assert.notEqual(assess({ workflow: { key: "codebase-assessment", version: 13 } }).key, base);
  assert.notEqual(assess({ workflow: { key: "codebase-assessment-v2", version: 12 } }).key, base);
  assert.notEqual(assess({ model: modelOf("claude", "claude-sonnet-5-5") }).key, base);
  assert.notEqual(assess({ model: modelOf("codex", "claude-opus-5-5") }).key, base);
  assert.notEqual(
    assess({
      rubricHash: rubricHash({
        instructions: "Assess the repository carefully.",
        outputContract: "{ findings: [] }",
        pinned: [{ key: "skill.ext.review", version: 3 }],
      }),
    }).key,
    base,
  );
  assert.notEqual(
    rca({ contract: "unified-rca/v2" }).key,
    rca().key,
    "the evidence-validity rules changed",
  );
  assert.notEqual(
    rca({ workflow: { key: "production-incident-investigation", version: 18 } }).key,
    rca().key,
  );
});

test("rubricHash: prompt, contract and pinned versions count; line endings, trailing spaces and pin order do not", () => {
  const base = {
    instructions: "Line one.\nLine two.",
    outputContract: "{ a }",
    pinned: [
      { key: "k.a", version: 1 },
      { key: "k.b", version: 2 },
    ],
  };
  const h = rubricHash(base);
  assert.equal(rubricHash({ ...base, instructions: "Line one.\r\nLine two.  \n" }), h);
  assert.equal(
    rubricHash({
      ...base,
      pinned: [
        { key: "k.b", version: 2 },
        { key: "k.a", version: 1 },
      ],
    }),
    h,
  );
  assert.notEqual(
    rubricHash({ ...base, instructions: "Line one.\nLine 2." }),
    h,
    "a changed word is a changed prompt",
  );
  assert.notEqual(rubricHash({ ...base, outputContract: "{ b }" }), h);
  assert.notEqual(
    rubricHash({
      ...base,
      pinned: [
        { key: "k.a", version: 1 },
        { key: "k.b", version: 3 },
      ],
    }),
    h,
    "a skill moved to a new version",
  );
  assert.notEqual(
    rubricHash({ ...base, pinned: [{ key: "k.a", version: 1 }] }),
    h,
    "a skill was dropped",
  );
  assert.notEqual(
    rubricHash({ ...base, instructions: "Line one. Line two." }),
    h,
    "inner whitespace is content",
  );
  assert.throws(
    () => rubricHash({ instructions: "x", pinned: [{ key: "k", version: 0 }] }),
    KeyError,
  );
});

test("modelOf needs the resolved model: never empty or a placeholder", () => {
  assert.equal(modelOf("Claude", "claude-opus-5-5"), "claude/claude-opus-5-5");
  for (const [p, m] of [
    ["", "m"],
    ["claude", ""],
    ["claude", "default"],
    ["claude", "AUTO"],
  ] as const)
    assert.throws(() => modelOf(p, m), KeyError, `${p}/${m}`);
});

test("workflow versions must be positive integers and rubric hashes real sha256 values", () => {
  for (const version of [0, -1, 1.5, Number.NaN])
    assert.throws(
      () => assess({ workflow: { key: "codebase-assessment", version } }),
      KeyError,
      String(version),
    );
  for (const bad of ["", "abc", "z".repeat(64)])
    assert.throws(() => assess({ rubricHash: bad }), KeyError, bad);
});
