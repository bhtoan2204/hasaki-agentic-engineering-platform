import { dirname } from "node:path";
import type { Node } from "web-tree-sitter";

/**
 * Deterministic AST probe for LATENT Go defects: code that raises no error, log or failing test until concurrent
 * traffic reaches it, so signal-driven assessment never points at it. Pure functions over parsed trees (no I/O, no model).
 * The probe lists candidates, not findings: every hit still has to be confirmed against the code by an agent and
 * demonstrated by a test (verification-recipes, kind CONCURRENCY). Bump LATENT_RISK_VERSION when a rule's output changes.
 */
export const LATENT_RISK_VERSION = "latent-risk-1";

export type LatentRule = "shared-instance-closure" | "exposed-guarded-state";

export interface LatentRisk {
  rule: LatentRule;
  confidence: "high" | "medium";
  path: string;
  line: number;
  /** pkg.Receiver.name like the code-intelligence symbols, so findings are tracked by (repo, kind, file, symbol). */
  symbol: string;
  message: string;
  /** How to demonstrate it: the test that fails now and passes after the fix. */
  hint: string;
}

interface StructInfo {
  /** Mutex field names; "" is an embedded sync.Mutex / sync.RWMutex. */
  locks: string[];
  /** Map and slice fields, by name. */
  shared: Record<string, "map" | "slice">;
}
/** Struct shapes by package directory + type name: methods and their struct often live in different files. */
export type StructIndex = Map<string, StructInfo>;

const field = (n: Node, name: string) => n.childForFieldName(name);
const kids = (n: Node | null | undefined): Node[] =>
  (n?.namedChildren ?? []).filter((c): c is Node => !!c && c.type !== "comment");
const lineOf = (n: Node) => n.startPosition.row + 1;
const structKey = (dir: string, type: string) => `${dir}\0${type}`;

const emptyInterface = (t: Node) => t.type === "interface_type" && kids(t).length === 0;
const typeErased = (t: Node) =>
  emptyInterface(t) || (t.type === "type_identifier" && t.text === "any");
/** Types whose copy still aliases the same underlying object. */
const aliasing = (t: Node) =>
  typeErased(t) || ["pointer_type", "map_type", "slice_type"].includes(t.type);

const FUNCTIONS = ["function_declaration", "method_declaration", "func_literal"];

function packageOf(root: Node): string {
  return root.namedChildren.find((n) => n?.type === "package_clause")?.namedChildren[0]?.text ?? "";
}

function receiverOf(method: Node): { name: string; type: string } | null {
  const param = kids(field(method, "receiver"))[0];
  if (!param) return null;
  const name = kids(param).find((c) => c.type === "identifier")?.text;
  const t = field(param, "type");
  const type = (t?.type === "pointer_type" ? kids(t)[0] : t)?.text;
  return name && type ? { name, type } : null;
}

function symbolOf(n: Node, pkg: string): string {
  for (let c: Node | null = n; c; c = c.parent) {
    if (c.type !== "function_declaration" && c.type !== "method_declaration") continue;
    const name = field(c, "name")?.text;
    const recv = c.type === "method_declaration" ? receiverOf(c)?.type : undefined;
    return [pkg, recv, name].filter(Boolean).join(".");
  }
  return [pkg, "(anonymous)"].filter(Boolean).join(".");
}

/** Mutex / map / slice fields of every struct declared in this file. */
export function collectStructs(root: Node, path: string, index: StructIndex): void {
  const dir = dirname(path);
  for (const spec of root.descendantsOfType("type_spec")) {
    const name = spec && field(spec, "name")?.text;
    const type = spec && field(spec, "type");
    if (!name || type?.type !== "struct_type") continue;
    const info: StructInfo = index.get(structKey(dir, name)) ?? { locks: [], shared: {} };
    for (const decl of type.descendantsOfType("field_declaration")) {
      const t = decl && field(decl, "type");
      if (!decl || !t) continue;
      const names = kids(decl)
        .filter((c) => c.type === "field_identifier")
        .map((c) => c.text);
      if (t.type === "qualified_type" && /^sync\.(RW)?Mutex$/.test(t.text))
        info.locks.push(...(names.length ? names : [""]));
      else if (t.type === "map_type" || t.type === "slice_type")
        for (const n of names) info.shared[n] = t.type === "map_type" ? "map" : "slice";
    }
    index.set(structKey(dir, name), info);
  }
}

const SHARED_INSTANCE_HINT =
  "Test: call the returned func twice and require two distinct instances (a, b := f(), f(); a == b fails the test for pointers), " +
  "then call it from N goroutines that each mutate their result, under go test -race. " +
  "Fix: build a fresh value per call (a constructor, or reflect.New(reflect.TypeOf(x).Elem()).Interface() for a prototype); never return the captured one.";
const GUARDED_STATE_HINT =
  "Test: read the returned value in one goroutine while another goroutine writes the field through the struct's setter, under go test -race. " +
  "Fix: copy the map/slice while the lock is held and return the copy.";

function sharedInstanceClosures(root: Node, path: string, pkg: string, out: LatentRisk[]) {
  for (const lit of root.descendantsOfType("func_literal")) {
    if (!lit || kids(field(lit, "parameters")).length) continue;
    const result = field(lit, "result");
    if (!result || !aliasing(result)) continue;
    const body = kids(field(lit, "body")).flatMap((s) =>
      s.type === "statement_list" ? kids(s) : [s],
    );
    if (body.length !== 1 || body[0].type !== "return_statement") continue;
    const ret = kids(body[0]);
    const exprs = ret[0]?.type === "expression_list" ? kids(ret[0]) : ret;
    if (exprs.length !== 1 || exprs[0].type !== "identifier") continue;
    const captured = exprs[0].text;
    let owner: Node | null = lit.parent;
    while (owner && !FUNCTIONS.includes(owner.type)) owner = owner.parent;
    if (!owner) continue;
    const declared = kids(field(owner, "parameters")).find(
      (p) =>
        p.type === "parameter_declaration" &&
        kids(p).some((c) => c.type === "identifier" && c.text === captured),
    );
    const type = declared && field(declared, "type");
    if (!type || !aliasing(type)) continue;
    const erased = typeErased(result) && typeErased(type);
    const symbol = symbolOf(lit, pkg);
    out.push({
      rule: "shared-instance-closure",
      confidence: erased ? "high" : "medium",
      path,
      line: lineOf(lit),
      symbol,
      message:
        `${symbol.split(".").pop()} returns a func() that hands back the captured ${captured} (${type.text}) on every call: all callers share one instance, ` +
        "so mutating the returned value from two goroutines is a data race" +
        (erased ? " (type-erased prototype pattern)." : "."),
      hint: SHARED_INSTANCE_HINT,
    });
  }
}

function exposedGuardedState(
  root: Node,
  path: string,
  pkg: string,
  structs: StructIndex,
  out: LatentRisk[],
) {
  const dir = dirname(path);
  for (const method of root.descendantsOfType("method_declaration")) {
    const recv = method && receiverOf(method);
    const result = method && field(method, "result");
    const body = method && field(method, "body");
    const info = recv && structs.get(structKey(dir, recv.type));
    if (!method || !recv || !info?.locks.length || !body) continue;
    if (!result || (result.type !== "map_type" && result.type !== "slice_type")) continue;
    const locks = body.descendantsOfType("call_expression").some((call) => {
      const fn = call && field(call, "function");
      if (fn?.type !== "selector_expression") return false;
      if (!["Lock", "RLock"].includes(field(fn, "field")?.text ?? "")) return false;
      const operand = field(fn, "operand")?.text;
      return info.locks.some((l) => (l ? operand === `${recv.name}.${l}` : operand === recv.name));
    });
    if (!locks) continue;
    for (const ret of body.descendantsOfType("return_statement")) {
      const parts = ret ? kids(ret) : [];
      const exprs = parts[0]?.type === "expression_list" ? kids(parts[0]) : parts;
      const sel = exprs.length === 1 && exprs[0].type === "selector_expression" ? exprs[0] : null;
      const name =
        sel && field(sel, "operand")?.text === recv.name ? field(sel, "field")?.text : null;
      if (!ret || !name || !info.shared[name]) continue;
      out.push({
        rule: "exposed-guarded-state",
        confidence: "high",
        path,
        line: lineOf(ret),
        symbol: symbolOf(method, pkg),
        message:
          `${recv.type}.${field(method, "name")?.text} locks and then returns the internal ${info.shared[name]} ${name}: ` +
          "once it returns, callers read or write it without the lock, a data race against every writer.",
        hint: GUARDED_STATE_HINT,
      });
      break;
    }
  }
}

/** Risks of one parsed Go file. structs must already hold the struct shapes of the package (collectStructs). */
export function detectLatentRisks(root: Node, path: string, structs: StructIndex): LatentRisk[] {
  const out: LatentRisk[] = [];
  const pkg = packageOf(root);
  sharedInstanceClosures(root, path, pkg, out);
  exposedGuardedState(root, path, pkg, structs, out);
  return out;
}
