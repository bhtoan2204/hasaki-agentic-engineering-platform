/**
 * TypeScript/JavaScript semantic navigation behind the LSP subset the platform uses (P1-B, ADR 0009).
 *
 * The TypeScript LanguageService API, not tsserver: project plugins (`compilerOptions.plugins`) are never loaded, no
 * project script runs, and every file read is confined to the workspace root (realpath inside it) or the TypeScript
 * library directory. Opened documents are overlays (the caller sends the live worktree text).
 */
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const MAX_FILES = 5000;
const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "out"]);
const SOURCE = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const LIB_DIR = dirname(ts.getDefaultLibFilePath({}));
let root = "";
let service = null;
const overlays = new Map(); // path → { text, version }
let files = [];

const inside = (p) => {
  let real;
  try {
    real = realpathSync(p);
  } catch {
    real = resolve(p);
  }
  for (const base of [root, LIB_DIR]) {
    const rel = relative(base, real);
    if (rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !rel.includes(`..${sep}`)))
      return true;
  }
  return false;
};
const readText = (p) => {
  if (overlays.has(p)) return overlays.get(p).text;
  if (!inside(p)) return undefined;
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};
const exists = (p) =>
  overlays.has(p) ||
  (inside(p) &&
    (() => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    })());

function walk(dir, out) {
  if (out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    if (e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) walk(p, out);
    } else if (SOURCE.has(extname(e.name)) && !e.name.endsWith(".d.ts.map")) out.push(p);
  }
}

function options() {
  const config = join(root, "tsconfig.json");
  let parsed = { options: {} };
  if (exists(config)) {
    const { config: json } = ts.parseConfigFileTextToJson(config, readText(config) ?? "{}");
    parsed = ts.parseJsonConfigFileContent(
      json ?? {},
      {
        useCaseSensitiveFileNames: true,
        readDirectory: () => [],
        fileExists: exists,
        readFile: readText,
      },
      root,
    );
  }
  const { plugins: _plugins, ...rest } = parsed.options;
  return { allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, ...rest };
}

function start(rootPath) {
  root = realpathSync(rootPath);
  walk(root, files);
  const compilerOptions = options();
  service = ts.createLanguageService(
    {
      getScriptFileNames: () => [...new Set([...files, ...overlays.keys()])],
      getScriptVersion: (p) => String(overlays.get(p)?.version ?? 0),
      getScriptSnapshot: (p) => {
        const text = readText(p);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => root,
      getCompilationSettings: () => compilerOptions,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: exists,
      readFile: readText,
      readDirectory: () => [],
      directoryExists: (d) => inside(d),
      getDirectories: () => [],
      useCaseSensitiveFileNames: () => true,
    },
    ts.createDocumentRegistry(),
  );
}

const pathOf = (uri) => fileURLToPath(uri);
const sourceFile = (p) => service.getProgram()?.getSourceFile(p);
function offsetOf(p, pos) {
  const sf = sourceFile(p);
  if (!sf) throw new Error("file is not part of the project");
  return ts.getPositionOfLineAndCharacter(sf, pos.line, pos.character);
}
function rangeOf(p, start, length) {
  const sf = sourceFile(p);
  const a = ts.getLineAndCharacterOfPosition(sf, start);
  const b = ts.getLineAndCharacterOfPosition(sf, start + length);
  return { start: a, end: b };
}
const location = (fileName, span) => ({
  uri: pathToFileURL(fileName).href,
  range: sourceFile(fileName)
    ? rangeOf(fileName, span.start, span.length)
    : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
});
const SYMBOL_KIND = {
  function: 12,
  class: 5,
  method: 6,
  property: 7,
  const: 14,
  let: 13,
  var: 13,
  interface: 11,
  enum: 10,
  type: 26,
  module: 2,
};

function symbols(p) {
  const out = [];
  const visit = (node) => {
    for (const child of node.childItems ?? []) {
      if (child.kind !== "alias" && child.text !== "<function>" && child.spans?.length) {
        const span = child.nameSpan ?? child.spans[0];
        const r = rangeOf(p, span.start, span.length);
        out.push({
          name: child.text,
          kind: SYMBOL_KIND[child.kind] ?? 13,
          range: r,
          selectionRange: r,
          children: [],
        });
      }
      visit(child);
    }
  };
  visit(service.getNavigationTree(p));
  return out;
}

const handlers = {
  initialize: (p) => {
    start(pathOf(p.rootUri));
    return {
      capabilities: {
        textDocumentSync: 1,
        definitionProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
        diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false },
        callHierarchyProvider: true,
      },
      serverInfo: { name: "platform-typescript", version: ts.version },
    };
  },
  shutdown: () => null,
  "textDocument/definition": (p) => {
    const file = pathOf(p.textDocument.uri);
    return (service.getDefinitionAtPosition(file, offsetOf(file, p.position)) ?? []).map((d) =>
      location(d.fileName, d.textSpan),
    );
  },
  "textDocument/references": (p) => {
    const file = pathOf(p.textDocument.uri);
    return (service.getReferencesAtPosition(file, offsetOf(file, p.position)) ?? []).map((r) =>
      location(r.fileName, r.textSpan),
    );
  },
  "textDocument/documentSymbol": (p) => symbols(pathOf(p.textDocument.uri)),
  "textDocument/diagnostic": (p) => {
    const file = pathOf(p.textDocument.uri);
    const items = [
      ...service.getSyntacticDiagnostics(file),
      ...service.getSemanticDiagnostics(file),
    ].map((d) => ({
      range: rangeOf(file, d.start ?? 0, d.length ?? 0),
      severity: d.category === ts.DiagnosticCategory.Error ? 1 : 2,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n").slice(0, 500),
    }));
    return { kind: "full", items };
  },
  "textDocument/prepareCallHierarchy": (p) => {
    const file = pathOf(p.textDocument.uri);
    const items = service.prepareCallHierarchy(file, offsetOf(file, p.position));
    return (Array.isArray(items) ? items : items ? [items] : []).map((i) => ({
      name: i.name,
      kind: 12,
      uri: pathToFileURL(i.file).href,
      range: rangeOf(i.file, i.span.start, i.span.length),
      selectionRange: rangeOf(i.file, i.selectionSpan.start, i.selectionSpan.length),
      data: { file: i.file, pos: i.selectionSpan.start },
    }));
  },
  "callHierarchy/incomingCalls": (p) =>
    service.provideCallHierarchyIncomingCalls(p.item.data.file, p.item.data.pos).map((c) => ({
      from: {
        name: c.from.name,
        kind: 12,
        uri: pathToFileURL(c.from.file).href,
        range: rangeOf(c.from.file, c.from.span.start, c.from.span.length),
        selectionRange: rangeOf(
          c.from.file,
          c.from.selectionSpan.start,
          c.from.selectionSpan.length,
        ),
      },
      fromRanges: c.fromSpans.map((s) => rangeOf(c.from.file, s.start, s.length)),
    })),
};
const notifications = {
  "textDocument/didOpen": (p) => {
    const file = pathOf(p.textDocument.uri);
    if (inside(file))
      overlays.set(file, { text: p.textDocument.text, version: p.textDocument.version });
  },
  "textDocument/didChange": (p) => {
    const file = pathOf(p.textDocument.uri);
    const text = p.contentChanges?.at(-1)?.text;
    if (inside(file) && typeof text === "string")
      overlays.set(file, { text, version: p.textDocument.version });
  },
  exit: () => process.exit(0),
};

const write = (m) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...m }));
  process.stdout.write(
    Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]),
  );
};
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(
      /Content-Length: *(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1] ?? -1,
    );
    if (length < 0 || buffer.length < end + 4 + length) return;
    const msg = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    if (msg.id === undefined) {
      notifications[msg.method]?.(msg.params);
      continue;
    }
    const h = handlers[msg.method];
    if (!h) {
      write({ id: msg.id, error: { code: -32601, message: `unsupported: ${msg.method}` } });
      continue;
    }
    try {
      write({ id: msg.id, result: h(msg.params) });
    } catch (e) {
      write({
        id: msg.id,
        error: { code: -32603, message: String(e?.message ?? e).slice(0, 500) },
      });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
