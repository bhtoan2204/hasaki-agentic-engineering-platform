import { Parser, Language, type Node } from "web-tree-sitter";
import { getWasmPath } from "tree-sitter-wasm";
import { config } from "../config.ts";
import { redactSecrets } from "../integrations/redact.ts";
import { hash, languageOf } from "./git.ts";

// Pinned package versions cover grammar provenance; changing extraction rules requires bumping extractor.
export const INDEX_VERSION = `extractor-1/runtime-0.27.1/grammars-2.0.4`;
export const parserVersion = () =>
  `${INDEX_VERSION}/${config.codeIntelligence.sqlDialect}/${config.codeIntelligence.maxSymbols}/${hash(JSON.stringify([config.codeIntelligence.maxFileBytes, config.codeIntelligence.excludes, config.codeIntelligence.includeGenerated, config.codeIntelligence.includeDependencies]))}`;
export class ParserLoadError extends Error {
  readonly language: string;
  constructor(language: string, cause: unknown) {
    super(`Parser unavailable (${language})`, { cause });
    this.language = language;
  }
}
let init: Promise<void> | undefined;
const languages = new Map<string, Promise<Language>>();
export interface SymbolRecord {
  symbol_name: string;
  qualified_name: string;
  symbol_kind: string;
  start_line: number;
  end_line: number;
  start_byte: number;
  end_byte: number;
  parent_symbol: string | null;
  signature: string;
}
export interface RelationRecord {
  source_name: string;
  target_name: string;
  relation_type: string;
  resolution: "resolved" | "candidate" | "unresolved";
  line: number;
}
export interface Extraction {
  language: string;
  content_hash: string;
  parser_version: string;
  symbols: SymbolRecord[];
  relations: RelationRecord[];
  parse_errors: number;
}
const unquote = (s: string) => s.replace(/^["'`]|["'`]$/g, "");
const field = (n: Node, name: string) => n.childForFieldName(name);
const child = (n: Node, type: string) => n.namedChildren.find((c) => c.type === type);
const names: Record<string, string> = {
  function_declaration: "function",
  function_signature: "function",
  method_declaration: "method",
  method_elem: "method",
  method_definition: "method",
  method_signature: "method",
  class_declaration: "class",
  abstract_class_declaration: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  message: "message",
  enum: "enum",
  service: "service",
  rpc: "rpc",
  create_table: "table",
  create_view: "view",
  create_index: "index",
  create_function: "function",
  column_definition: "column",
};

export async function extract(
  path: string,
  source: string,
  signal?: AbortSignal,
): Promise<Extraction | null> {
  const language = languageOf(path);
  if (
    !language ||
    Buffer.byteLength(source) > config.codeIntelligence.maxFileBytes ||
    source.includes("\0")
  )
    return null;
  try {
    await (init ??= Parser.init().catch((error) => {
      init = undefined;
      throw error;
    }));
  } catch (error) {
    throw new ParserLoadError(language, error);
  }
  signal?.throwIfAborted();
  const grammar =
    languages.get(language) ??
    Language.load(getWasmPath(language as Parameters<typeof getWasmPath>[0]));
  languages.set(language, grammar);
  void grammar.catch(() => {
    if (languages.get(language) === grammar) languages.delete(language);
  });
  const parser = new Parser();
  let tree;
  const deadline = Date.now() + Math.min(5000, config.codeIntelligence.timeoutMs);
  try {
    try {
      parser.setLanguage(await grammar);
    } catch (error) {
      throw new ParserLoadError(language, error);
    }
    tree = parser.parse(source, null, {
      progressCallback: () => signal?.aborted === true || Date.now() > deadline,
    });
    if (!tree) throw new Error("Parser deadline exceeded");
    const out: Extraction = {
      language,
      content_hash: hash(source),
      parser_version: parserVersion(),
      symbols: [],
      relations: [],
      parse_errors: 0,
    };
    const packageNode = tree.rootNode.namedChildren.find(
      (n) => n.type === "package_clause" || n.type === "package",
    );
    const pkg = packageNode?.namedChildren[0]?.text ?? "";
    const relation = (
      n: Node,
      src: string,
      target: string,
      kind: string,
      resolution: RelationRecord["resolution"] = "unresolved",
    ) => {
      if (target && out.relations.length < config.codeIntelligence.maxSymbols * 4)
        out.relations.push({
          source_name: src,
          target_name: unquote(target).slice(0, 512),
          relation_type: kind,
          resolution,
          line: n.startPosition.row + 1,
        });
    };
    // Iterative traversal prevents malformed/deep source exhausting the JS call stack.
    const stack: Array<{ n: Node; parent: string | null }> = [{ n: tree.rootNode, parent: null }];
    let visited = 0;
    while (stack.length) {
      if (++visited > 200000 || Date.now() > deadline) throw new Error("Extractor limit exceeded");
      signal?.throwIfAborted();
      const { n, parent } = stack.pop()!;
      if (n.type === "ERROR" || n.isMissing) {
        out.parse_errors++;
        continue;
      }
      let kind = names[n.type],
        name = field(n, "name")?.text;
      if (n.type === "package_clause" || n.type === "package") {
        kind = "package";
        name = pkg;
      }
      if (n.type === "type_spec") {
        const t = field(n, "type")?.type;
        kind = t === "struct_type" ? "struct" : t === "interface_type" ? "interface" : "type";
      }
      if (
        n.type === "variable_declarator" &&
        ["arrow_function", "function_expression"].includes(field(n, "value")?.type ?? "")
      )
        kind = "function";
      if (["message", "enum", "service", "rpc"].includes(n.type))
        name = child(n, `${n.type}_name`)?.text;
      if (n.type.startsWith("create_"))
        name = child(n, "object_reference")?.text ?? field(n, "column")?.text;
      if (n.type === "create_index") name = field(n, "column")?.text ?? name;
      let scope = parent;
      if (kind && name && out.symbols.length < config.codeIntelligence.maxSymbols) {
        const receiver = field(n, "receiver")
          ?.namedChildren[0]?.childForFieldName("type")
          ?.text.replace(/^\*/, "");
        const qualified = [parent ?? (pkg && kind !== "package" ? pkg : null), receiver, name]
          .filter(Boolean)
          .join(".");
        const body = field(n, "body") ?? child(n, "message_body");
        // Signatures only; SQL/proto bodies can contain literals, so truncate at the declaration boundary.
        const headerEnd =
          body?.startIndex ??
          Math.min(
            n.endIndex,
            source.indexOf("\n", n.startIndex) < 0
              ? n.endIndex
              : source.indexOf("\n", n.startIndex),
          );
        let signature = source
          .slice(n.startIndex, headerEnd)
          .split(/\bAS\s+\$\$|\{/i)[0]
          .trim()
          .slice(0, 400);
        signature = redactSecrets(signature).replace(/(['"])(?:\\.|(?!\1).)*?\1/g, '"…"');
        out.symbols.push({
          symbol_name: name,
          qualified_name: qualified,
          symbol_kind: kind,
          start_line: n.startPosition.row + 1,
          end_line: n.endPosition.row + 1,
          start_byte: Buffer.byteLength(source.slice(0, n.startIndex)),
          end_byte: Buffer.byteLength(source.slice(0, n.endIndex)),
          parent_symbol: parent,
          signature,
        });
        relation(n, parent ?? pkg, qualified, "DEFINES", "resolved");
        if (n.parent?.type === "export_statement" || n.parent?.parent?.type === "export_statement")
          relation(n, "export", qualified, "REFERENCES", "resolved");
        scope = qualified;
        if (n.type === "rpc") {
          const types = n.namedChildren.filter((c) => c.type === "message_or_enum_type");
          if (types[0]) relation(n, qualified, types[0].text, "RPC_REQUEST", "candidate");
          if (types[1]) relation(n, qualified, types[1].text, "RPC_RESPONSE", "candidate");
        }
      }
      if (["import_spec", "import_statement", "import", "export_statement"].includes(n.type)) {
        const target = field(n, "path") ?? field(n, "source");
        if (target) relation(n, parent ?? pkg, target.text, "IMPORTS");
      }
      if (n.type === "export_statement") {
        for (const c of n.namedChildren.filter((c) => c.type === "export_clause"))
          relation(n, pkg, c.text, "REFERENCES", "candidate");
      }
      if (n.type === "call_expression") {
        relation(n, parent ?? pkg, field(n, "function")?.text ?? "", "CALLS", "candidate");
        for (const argument of field(n, "arguments")?.namedChildren ?? []) {
          if (!["interpreted_string_literal", "string"].includes(argument.type)) continue;
          const rpc = /^\/([A-Za-z_][\w.]*)\/([A-Za-z_]\w*)$/.exec(unquote(argument.text));
          if (rpc) relation(n, parent ?? pkg, `${rpc[1]}.${rpc[2]}`, "REFERENCES", "candidate");
        }
      }
      if (n.type === "implements_clause")
        for (const c of n.namedChildren)
          relation(n, parent ?? pkg, c.text, "IMPLEMENTS", "candidate");
      if (
        language === "sql" &&
        n.type === "object_reference" &&
        !(
          n.parent?.type.startsWith("create_") &&
          n.parent.namedChildren.find((c) => c.type === "object_reference")?.id === n.id
        )
      )
        relation(n, parent ?? "", n.text, "REFERENCES", "candidate");
      for (const c of [...n.namedChildren].reverse()) stack.push({ n: c, parent: scope });
    }
    return out;
  } finally {
    tree?.delete();
    parser.delete();
  }
}
