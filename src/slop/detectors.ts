import { createHash } from "node:crypto";
import type { Node } from "web-tree-sitter";
import type { SlopSettings, SlopSeverity } from "../config.ts";
import { redactSecrets } from "../integrations/redact.ts";
import type { FindingKind, RawFinding } from "./findings.ts";

/**
 * Deterministic AST rules for slop detection (TypeScript/TSX/JavaScript share one node table, Go has its own).
 * Pure functions over a parsed tree: no I/O, no model calls. Bump DETECTOR_VERSION whenever a rule's output changes,
 * so cached results are invalidated.
 */
export const DETECTOR_VERSION = "slop-detectors-1";

export const RULES: Record<string, { category: string; kind: FindingKind }> = {
  "unreachable-code": { category: "dead-code", kind: "deterministic" },
  "silent-error": { category: "error-handling", kind: "deterministic" },
  placeholder: { category: "placeholder", kind: "deterministic" },
  complexity: { category: "complexity", kind: "heuristic" },
  "duplicate-block": { category: "duplication", kind: "heuristic" },
  "commented-out-code": { category: "verbosity", kind: "heuristic" },
  "comment-density": { category: "verbosity", kind: "heuristic" },
  "meaningless-assertion": { category: "test-quality", kind: "heuristic" },
  "test-without-assertion": { category: "test-quality", kind: "heuristic" },
};
/** Rules of the "micro" level: cheap and deterministic. */
export const MICRO_RULES = ["unreachable-code", "silent-error", "placeholder"];
/** Requested categories this phase cannot detect from syntax alone; reported explicitly, never silently skipped. */
export const UNSUPPORTED_RULES: Array<{
  rule: string;
  status: "unsupported" | "covered_by";
  detail: string;
}> = [
  ...[
    "unnecessary-abstraction",
    "architecture-erosion",
    "reinvented-utility",
    "redundant-validation",
    "obsolete-compat",
  ].map((rule) => ({
    rule,
    status: "unsupported" as const,
    detail: "needs semantic analysis (not in phase 1)",
  })),
  { rule: "out-of-scope-change", status: "covered_by", detail: "scopeGuard" },
];
export const SUPPORTED_LANGUAGES = ["typescript", "tsx", "javascript", "go"];

export interface DetectorOptions {
  rules: ReadonlySet<string>;
  thresholds: SlopSettings["thresholds"];
}
/** Structural hash of a function body, matched across files by duplicates(). */
export interface Shape {
  hash: string;
  path: string;
  line: number;
  symbol: string;
  snippet: string;
}

interface Table {
  functions: Set<string>;
  blocks: Set<string>;
  terminators: Set<string>;
  /** Siblings after a terminator that are still reachable or not code (hoisted declarations, labels, comments). */
  reachable: Set<string>;
  decisions: Set<string>;
  nesting: Set<string>;
  literals: Set<string>;
  identifiers: Set<string>;
  named: Set<string>;
}
const JS: Table = {
  functions: new Set([
    "function_declaration",
    "function_expression",
    "arrow_function",
    "method_definition",
    "generator_function_declaration",
    "generator_function",
  ]),
  blocks: new Set([
    "statement_block",
    "switch_case",
    "switch_default",
    "program",
    "class_static_block",
  ]),
  terminators: new Set([
    "return_statement",
    "throw_statement",
    "break_statement",
    "continue_statement",
  ]),
  reachable: new Set([
    "function_declaration",
    "generator_function_declaration",
    "comment",
    "empty_statement",
  ]),
  decisions: new Set([
    "if_statement",
    "for_statement",
    "for_in_statement",
    "while_statement",
    "do_statement",
    "catch_clause",
    "ternary_expression",
    "switch_case",
  ]),
  nesting: new Set([
    "if_statement",
    "for_statement",
    "for_in_statement",
    "while_statement",
    "do_statement",
    "catch_clause",
    "ternary_expression",
    "switch_statement",
  ]),
  literals: new Set([
    "string",
    "template_string",
    "number",
    "true",
    "false",
    "null",
    "undefined",
    "regex",
  ]),
  identifiers: new Set([
    "identifier",
    "property_identifier",
    "shorthand_property_identifier",
    "type_identifier",
    "private_property_identifier",
  ]),
  named: new Set([
    "function_declaration",
    "generator_function_declaration",
    "method_definition",
    "class_declaration",
    "abstract_class_declaration",
  ]),
};
const GO: Table = {
  functions: new Set(["function_declaration", "method_declaration", "func_literal"]),
  blocks: new Set(["statement_list", "source_file"]),
  terminators: new Set([
    "return_statement",
    "break_statement",
    "continue_statement",
    "goto_statement",
  ]),
  reachable: new Set([
    "comment",
    "labeled_statement",
    "empty_statement",
    "function_declaration",
    "method_declaration",
  ]),
  decisions: new Set([
    "if_statement",
    "for_statement",
    "expression_case",
    "type_case",
    "communication_case",
  ]),
  nesting: new Set([
    "if_statement",
    "for_statement",
    "expression_switch_statement",
    "type_switch_statement",
    "select_statement",
  ]),
  literals: new Set([
    "interpreted_string_literal",
    "raw_string_literal",
    "int_literal",
    "float_literal",
    "rune_literal",
    "imaginary_literal",
    "true",
    "false",
    "nil",
    "iota",
  ]),
  identifiers: new Set(["identifier", "field_identifier", "type_identifier", "package_identifier"]),
  named: new Set(["function_declaration", "method_declaration"]),
};
const LOGICAL = new Set(["&&", "||", "??"]);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$/;
const PLACEHOLDER = /\bnot\s+(yet\s+)?implemented\b|\bunimplemented\b|^\s*TODO\b/i;
const TODO_COMMENT = /\b(TODO|FIXME|XXX|HACK)\b/;
const MAX_NODES = 200000;

const lineOf = (n: Node) => n.startPosition.row + 1;
const lines = (n: Node) => n.endPosition.row - n.startPosition.row + 1;
const field = (n: Node, name: string) => n.childForFieldName(name);
/** Bounded, redacted evidence: the first lines of the node. */
export function snippet(n: Node | string, maxChars = 300): string {
  const text = (typeof n === "string" ? n : n.text)
    .split("\n")
    .slice(0, 4)
    .map((l) => l.trimEnd())
    .join("\n");
  return redactSecrets(text.length > maxChars ? `${text.slice(0, maxChars)}…` : text);
}
const isGoPanic = (n: Node) =>
  n.type === "expression_statement" &&
  n.namedChildren[0]?.type === "call_expression" &&
  field(n.namedChildren[0], "function")?.text === "panic";
const stringsIn = (n: Node, t: Table) =>
  n.descendantsOfType([...t.literals]).flatMap((d) => (d && /string/.test(d.type) ? [d.text] : []));

/** Qualified name of the enclosing declarations, computed like the code-intelligence extractor (pkg.Receiver.name). */
function symbolOf(n: Node | null, t: Table, pkg: string): string {
  const parts: string[] = [];
  for (let c = n; c; c = c.parent) {
    let name: string | undefined;
    if (t.named.has(c.type)) name = field(c, "name")?.text;
    else if (
      c.type === "variable_declarator" &&
      ["arrow_function", "function_expression"].includes(field(c, "value")?.type ?? "")
    )
      name = field(c, "name")?.text;
    if (!name) continue;
    const receiver = field(c, "receiver")
      ?.namedChildren[0]?.childForFieldName("type")
      ?.text.replace(/^\*/, "");
    parts.unshift(...[receiver, name].filter((x): x is string => !!x));
  }
  return [pkg, ...parts].filter(Boolean).join(".");
}

/** Run every enabled rule over one parsed file. `deadline` bounds the traversal like the extractor does. */
export function detect(
  language: string,
  path: string,
  root: Node,
  opts: DetectorOptions,
  deadline = Date.now() + 5000,
): { findings: RawFinding[]; shapes: Shape[] } {
  const t = language === "go" ? GO : JS;
  const pkg =
    language === "go"
      ? (root.namedChildren.find((n) => n.type === "package_clause")?.namedChildren[0]?.text ?? "")
      : "";
  const findings: RawFinding[] = [];
  const shapes: Shape[] = [];
  const on = (rule: string) => opts.rules.has(rule);
  const add = (
    rule: string,
    n: Node,
    severity: SlopSeverity,
    confidence: number,
    message: string,
    extra: Partial<RawFinding> = {},
  ) =>
    findings.push({
      rule,
      ...RULES[rule],
      severity,
      confidence,
      path,
      line: lineOf(n),
      symbol: symbolOf(n, t, pkg),
      snippet: snippet(n),
      message,
      ...extra,
    });
  const test = TEST_FILE.test(path);
  // One bounded pre-order walk; rules below inspect the collected nodes.
  const nodes: Node[] = [];
  const stack: Node[] = [root];
  while (stack.length) {
    if (nodes.length > MAX_NODES || Date.now() > deadline)
      throw new Error("Detector limit exceeded");
    const n = stack.pop()!;
    nodes.push(n);
    for (let i = n.namedChildCount - 1; i >= 0; i--) stack.push(n.namedChild(i)!);
  }
  let previousCodeComment = -2;
  for (const n of nodes) {
    if (on("unreachable-code") && t.blocks.has(n.type)) {
      const kids = n.namedChildren.filter((c): c is Node => !!c);
      const at = kids.findIndex(
        (c) => t.terminators.has(c.type) || (language === "go" && isGoPanic(c)),
      );
      const dead = at < 0 ? undefined : kids.slice(at + 1).find((c) => !t.reachable.has(c.type));
      if (dead)
        add(
          "unreachable-code",
          dead,
          "high",
          0.95,
          `statement after ${kids[at].type.replace(/_statement$/, "")} can never run`,
        );
    }
    if (on("silent-error")) {
      let body: Node | null = null;
      if (n.type === "catch_clause") body = field(n, "body");
      else if (language === "go" && n.type === "if_statement" && !field(n, "alternative")) {
        const cond = field(n, "condition");
        if (cond?.type === "binary_expression" && /^\w*err\w*\s*!=\s*nil$/i.test(cond.text))
          body = field(n, "consequence");
      }
      if (body) {
        const code = body.descendantsOfType("comment").length;
        const statements = body.namedChildren.filter(
          (c) =>
            c &&
            c.type !== "comment" &&
            !(c.type === "statement_list" && !c.namedChildren.some((s) => s?.type !== "comment")),
        );
        if (!statements.length)
          add(
            "silent-error",
            n,
            code ? "low" : "high",
            code ? 0.5 : 0.9,
            code
              ? "error swallowed (only a comment explains it)"
              : "error swallowed silently: empty handler",
          );
      }
    }
    if (on("placeholder")) {
      const stub = n.type === "throw_statement" || (language === "go" && isGoPanic(n));
      if (stub && stringsIn(n, t).some((s) => PLACEHOLDER.test(s.replace(/^["'`]|["'`]$/g, ""))))
        add("placeholder", n, "high", 0.95, "placeholder implementation left in code");
      if (n.type === "comment" && TODO_COMMENT.test(n.text))
        add("placeholder", n, "low", 0.9, "TODO/FIXME marker");
    }
    if (n.type === "comment" && on("commented-out-code")) {
      const body = n.text.replace(/^\/\/\s?|^\/\*+|\*+\/$/g, "").trim();
      const code =
        /^\/\//.test(n.text) &&
        (/[;{}]\s*$/.test(body) ||
          /^(?:const|let|var|return|if|for|func|import|await|defer)\b.*[=({]/.test(body) ||
          /^\w+(?:\.\w+)*\(.*\)$/.test(body)) &&
        !/\b(TODO|FIXME|eslint|@ts-|go:|nolint)\b/.test(body);
      if (code && previousCodeComment !== n.startPosition.row - 1)
        add("commented-out-code", n, "low", 0.5, "commented-out code");
      if (code) previousCodeComment = n.startPosition.row;
    }
    if (t.functions.has(n.type)) {
      const body = field(n, "body");
      if (!body) continue;
      if (on("complexity")) {
        const m = complexity(body, t, deadline);
        const th = opts.thresholds;
        if (m.cyclomatic > th.cyclomatic || m.cognitive > th.cognitive)
          add(
            "complexity",
            n,
            m.cyclomatic > th.cyclomaticHigh ? "high" : "medium",
            0.6,
            `cyclomatic ${m.cyclomatic} (limit ${th.cyclomatic}), cognitive ${m.cognitive} (limit ${th.cognitive})`,
            { value: m.cyclomatic, snippet: snippet(n.text.split("\n")[0]) },
          );
      }
      if (on("comment-density") && lines(n) >= 10) {
        const commentLines = body
          .descendantsOfType("comment")
          .reduce((s, c) => s + (c ? lines(c) : 0), 0);
        if (commentLines / lines(n) > 0.4)
          add(
            "comment-density",
            n,
            "low",
            0.5,
            `${commentLines} of ${lines(n)} lines are comments`,
            { snippet: snippet(n.text.split("\n")[0]) },
          );
      }
      if (on("duplicate-block") && lines(n) >= opts.thresholds.duplicateLines)
        shapes.push({
          hash: structure(body, t),
          path,
          line: lineOf(n),
          symbol: symbolOf(n, t, pkg),
          snippet: snippet(n.text.split("\n")[0]),
        });
      if (
        test &&
        on("test-without-assertion") &&
        language === "go" &&
        n.type === "function_declaration" &&
        /^Test[A-Z0-9_]/.test(field(n, "name")?.text ?? "") &&
        !/\bt\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow|Run)\(|\b(assert|require)\.|\.Expect\(|\bgomock\.|\(\s*t\s*[,)]/.test(
          body.text,
        )
      )
        add("test-without-assertion", n, "medium", 0.6, "test has no assertion", {
          snippet: snippet(n.text.split("\n")[0]),
        });
    }
    if (test && n.type === "call_expression") {
      const callee = field(n, "function");
      const args = (field(n, "arguments")?.namedChildren ?? []).filter(
        (a): a is Node => !!a && a.type !== "comment",
      );
      if (
        on("test-without-assertion") &&
        language !== "go" &&
        callee &&
        ["it", "test"].includes(callee.text)
      ) {
        const fn = args.find((a) => t.functions.has(a.type));
        if (
          fn &&
          !/\b(expect|assert)\b|\.should\b|\bt\.(ok|is|equal|true|throws|snapshot)\b/.test(fn.text)
        )
          add("test-without-assertion", n, "medium", 0.6, "test has no assertion", {
            snippet: snippet(n.text.split("\n")[0]),
          });
      }
      if (on("meaningless-assertion") && callee && meaningless(callee, args, t))
        add(
          "meaningless-assertion",
          n,
          "medium",
          0.7,
          "assertion compares constants and can never fail",
        );
    }
  }
  return { findings, shapes };
}

/** Cyclomatic (decisions + logical operators + 1) and cognitive (nesting-weighted) complexity of one function body. */
function complexity(body: Node, t: Table, deadline: number) {
  let cyclomatic = 1;
  let cognitive = 0;
  const stack: Array<{ n: Node; depth: number }> = [{ n: body, depth: 0 }];
  while (stack.length) {
    if (Date.now() > deadline) throw new Error("Detector limit exceeded");
    const { n, depth } = stack.pop()!;
    if (n !== body && t.functions.has(n.type)) continue; // nested functions are measured on their own
    if (t.decisions.has(n.type)) cyclomatic++;
    let next = depth;
    if (t.nesting.has(n.type)) {
      cognitive += 1 + depth;
      next = depth + 1;
    }
    if (n.type === "else_clause" || (n.type === "if_statement" && field(n, "alternative")))
      cognitive++;
    if (n.type === "binary_expression") {
      const op = field(n, "operator")?.type ?? n.child(1)?.type ?? "";
      if (LOGICAL.has(op)) {
        cyclomatic++;
        const parentOp =
          n.parent?.type === "binary_expression"
            ? (field(n.parent, "operator")?.type ?? n.parent.child(1)?.type)
            : null;
        if (parentOp !== op) cognitive++;
      }
    }
    for (const c of n.namedChildren) if (c) stack.push({ n: c, depth: next });
  }
  return { cyclomatic, cognitive };
}

/** Hash of the node-type sequence with identifiers and literals abstracted, so renamed copies still match. */
function structure(body: Node, t: Table): string {
  const out: string[] = [];
  const stack: Node[] = [body];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === "comment") continue;
    if (t.identifiers.has(n.type)) out.push("ID");
    else if (t.literals.has(n.type)) out.push("LIT");
    else {
      out.push(n.type);
      for (let i = n.namedChildCount - 1; i >= 0; i--) stack.push(n.namedChild(i)!);
    }
  }
  return createHash("sha256").update(out.join(" ")).digest("hex");
}

function meaningless(callee: Node, args: Node[], t: Table): boolean {
  const literal = (a?: Node) => !!a && t.literals.has(a.type);
  const name = callee.text;
  if (/^assert(\.ok)?$/.test(name)) return args.length >= 1 && args[0].type === "true";
  if (/^assert\.(equal|strictEqual|deepEqual|deepStrictEqual)$/.test(name))
    return literal(args[0]) && literal(args[1]) && args[0].text === args[1].text;
  if (/^(assert|require)\.True$/.test(name)) return args[1]?.type === "true";
  if (/^(assert|require)\.(Equal|EqualValues)$/.test(name))
    return literal(args[1]) && literal(args[2]) && args[1].text === args[2].text;
  // expect(LIT).toBe(LIT) / toEqual / toStrictEqual
  const object = field(callee, "object");
  if (
    callee.type === "member_expression" &&
    object?.type === "call_expression" &&
    field(object, "function")?.text === "expect" &&
    /^(toBe|toEqual|toStrictEqual)$/.test(field(callee, "property")?.text ?? "")
  ) {
    const actual = field(object, "arguments")?.namedChildren[0] ?? undefined;
    return literal(actual) && literal(args[0]) && actual!.text === args[0].text;
  }
  return false;
}

/** Functions with the same structure (≥ duplicateLines lines) across the scanned files; the first by path/line is the original. */
export function duplicates(shapes: Shape[]): RawFinding[] {
  const groups = new Map<string, Shape[]>();
  for (const s of shapes) groups.set(s.hash, [...(groups.get(s.hash) ?? []), s]);
  const out: RawFinding[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [first, ...rest] = [...group].sort(
      (a, b) => a.path.localeCompare(b.path) || a.line - b.line,
    );
    for (const s of rest)
      out.push({
        rule: "duplicate-block",
        ...RULES["duplicate-block"],
        severity: "medium",
        confidence: 0.6,
        path: s.path,
        line: s.line,
        symbol: s.symbol,
        snippet: s.snippet,
        message: `same structure as ${first.symbol || "a function"} (${first.path}:${first.line})`,
      });
  }
  return out;
}
