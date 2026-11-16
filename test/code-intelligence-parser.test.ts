import { test } from "node:test";
import assert from "node:assert/strict";
import { extract } from "../src/codeIntelligence/parser.ts";
import { config } from "../src/config.ts";

test("Go packages, imports, functions, receivers, structs, interfaces, calls and UTF8 byte offsets", async () => {
  const source =
    'package pay\nimport "fmt"\n// 日本語\ntype S struct { X int }; type P interface { Pay() }; type ID string; func Charge() {} ; func (s *S) Pay() { fmt.Println("ok") }';
  const e = (await extract("a.go", source))!;
  for (const [name, kind] of [
    ["pay", "package"],
    ["S", "struct"],
    ["P", "interface"],
    ["ID", "type"],
    ["Charge", "function"],
    ["Pay", "method"],
  ])
    assert.ok(
      e.symbols.some((s) => s.symbol_name === name && s.symbol_kind === kind),
      `${name}: ${JSON.stringify(e.symbols)}`,
    );
  const method = e.symbols.find(
    (s) => s.qualified_name === "pay.S.Pay" && s.symbol_kind === "method",
  )!;
  assert.equal(method.qualified_name, "pay.S.Pay");
  assert.ok(e.symbols.some((s) => s.qualified_name === "pay.P.Pay" && s.symbol_kind === "method"));
  assert.equal(
    Buffer.from(source)
      .subarray(method.start_byte, method.end_byte)
      .toString()
      .startsWith("func (s *S)"),
    true,
  );
  assert.ok(e.relations.some((r) => r.relation_type === "IMPORTS" && r.target_name === "fmt"));
  assert.ok(e.relations.some((r) => r.relation_type === "CALLS" && r.resolution === "candidate"));
});
test("TypeScript/TSX functions, classes, methods, interfaces, aliases and export imports", async () => {
  for (const path of ["a.ts", "a.tsx"]) {
    const e = (await extract(
      path,
      'import {charge} from "./pay"; export class A implements B { pay() {return charge()} }; export function foo() {}; export const bar = () => 1; interface B {pay(): void}; type ID = string; export {X} from "./x";',
    ))!;
    for (const name of ["A", "pay", "foo", "bar", "B", "ID"])
      assert.ok(
        e.symbols.some((s) => s.symbol_name === name),
        name,
      );
    assert.ok(e.relations.some((r) => r.target_name === "./pay"));
    assert.ok(e.relations.some((r) => r.relation_type === "IMPLEMENTS"));
  }
});
test("Proto messages, nested enums, package, service and RPC request/response candidates", async () => {
  const e = (await extract(
    "pay.proto",
    'syntax="proto3"; package pay.v1; import "common.proto"; message Req { enum Kind { NONE = 0; } } message Res {} service Pay { rpc Charge (Req) returns (Res); }',
  ))!;
  for (const [name, kind] of [
    ["pay.v1", "package"],
    ["Req", "message"],
    ["Kind", "enum"],
    ["Pay", "service"],
    ["Charge", "rpc"],
  ])
    assert.ok(
      e.symbols.some((s) => s.symbol_name === name && s.symbol_kind === kind),
      name,
    );
  assert.ok(
    e.relations.some(
      (r) =>
        r.relation_type === "RPC_REQUEST" &&
        r.target_name === "Req" &&
        r.resolution === "candidate",
    ),
  );
  assert.ok(e.relations.some((r) => r.relation_type === "RPC_RESPONSE" && r.target_name === "Res"));
});
test("SQL objects, columns, foreign key references; unsupported dialect fragments fail softly", async () => {
  const e = (await extract(
    "a.sql",
    "CREATE TABLE orders (id bigint PRIMARY KEY, user_id bigint REFERENCES users(id)); CREATE VIEW recent AS SELECT * FROM orders; CREATE INDEX ix ON orders(id); CREATE FUNCTION foo() RETURNS int AS $$ SELECT 1 $$ LANGUAGE SQL;",
  ))!;
  for (const [name, kind] of [
    ["orders", "table"],
    ["id", "column"],
    ["recent", "view"],
    ["ix", "index"],
    ["foo", "function"],
  ])
    assert.ok(
      e.symbols.some((s) => s.symbol_name === name && s.symbol_kind === kind),
      name,
    );
  assert.ok(e.relations.some((r) => r.target_name === "users" && r.relation_type === "REFERENCES"));
  assert.ok(
    await extract("a.sql", "DELIMITER $$ nonsense invalid GO; CREATE TABLE valid (id int);"),
  );
});
test("Invalid syntax, unsupported language, binary, oversized source and symbol limits", async () => {
  assert.ok((await extract("a.go", "package p\nfunc Broken( {"))!.parse_errors > 0);
  assert.equal(await extract("a.py", "def foo(): pass"), null);
  assert.equal(await extract("a.go", "\0"), null);
  assert.equal(await extract("a.go", "x".repeat(config.codeIntelligence.maxFileBytes + 1)), null);
  const old = config.codeIntelligence.maxSymbols;
  config.codeIntelligence.maxSymbols = 2;
  try {
    assert.ok((await extract("a.go", "package p\nfunc A() {}\nfunc B() {}"))!.symbols.length <= 2);
  } finally {
    config.codeIntelligence.maxSymbols = old;
  }
});

test("Generated RPC wire paths link client calls as candidates, never resolved calls", async () => {
  const e = (await extract(
    "client.pb.go",
    'package pay\nfunc Charge() { cc.Invoke(ctx, "/pay.Payment/Charge", in, out) }',
  ))!;
  assert.ok(
    e.relations.some(
      (r) =>
        r.relation_type === "REFERENCES" &&
        r.target_name === "pay.Payment.Charge" &&
        r.resolution === "candidate",
    ),
  );
});
