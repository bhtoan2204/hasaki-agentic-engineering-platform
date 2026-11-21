/**
 * Semantic code navigation (P1-B, ADR 0009): definition, references, document symbols, diagnostics and incoming calls
 * from a language server, over the authorized checkout or the run's worktree.
 *
 * Authorization is the code-intelligence path: the repository must be in the caller's allowed set and pass
 * `localScope` (registry enabled + readable; for a run, the run's own worktree on this worker). The file must be a
 * relative, non-secret path without symlink components (`readSource`). The server is given the live file text and is
 * keyed by a workspace fingerprint (HEAD + changed files), so uncommitted edits are what it answers about; the file and
 * fingerprint are re-checked after the answer and a change in between yields `stale` with no locations. Locations
 * outside the root (standard library, module cache, lib.d.ts) are only counted. Results are bounded.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "../../config.ts";
import { localScope } from "../indexer.ts";
import { readSource } from "../git.ts";
import { isSecretPath } from "../../agent/toolPolicy.ts";
import { LspError, type Diagnostic, type Location, type Range } from "./client.ts";
import { getSession, LspUnavailable, type Language } from "./sessions.ts";

const exec = promisify(execFile);
export type NavOperation =
  "definition" | "references" | "document_symbols" | "diagnostics" | "incoming_calls";
export type NavStatus =
  | "ok"
  | "not_found"
  | "ambiguous"
  | "unsupported"
  | "unavailable"
  | "timeout"
  | "canceled"
  | "stale"
  | "unauthorized"
  | "invalid";
export interface NavLocation {
  path: string;
  line: number;
  character: number;
  end_line: number;
  name?: string;
  kind?: number;
}
export interface NavResult {
  status: NavStatus;
  locations: NavLocation[];
  external?: number;
  more?: number;
  candidates?: Array<{ name: string; line: number }>;
  diagnostics?: Array<{ line: number; character: number; severity: number; message: string }>;
  provenance?: {
    repository: string;
    root_kind: "worktree" | "checkout";
    head: string;
    file_sha256: string;
    workspace_fingerprint: string;
    server: Language;
  };
  error?: string;
}
export interface NavRequest {
  repository: string;
  path: string;
  operation: NavOperation;
  /** 1-based line and column of the symbol occurrence. */
  line?: number;
  character?: number;
  /** Alternative to a position: a declaration name in `path` (must be unique there). */
  symbol?: string;
}

const LANGUAGE: Record<string, { server: Language; id: string }> = {
  ".go": { server: "go", id: "go" },
  ".ts": { server: "ts", id: "typescript" },
  ".tsx": { server: "ts", id: "typescriptreact" },
  ".mts": { server: "ts", id: "typescript" },
  ".cts": { server: "ts", id: "typescript" },
  ".js": { server: "ts", id: "javascript" },
  ".jsx": { server: "ts", id: "javascriptreact" },
  ".mjs": { server: "ts", id: "javascript" },
  ".cjs": { server: "ts", id: "javascript" },
};

let afterAnswer: (() => void) | undefined;
/** Tests only: runs between the server's answer and the freshness re-check. */
export function setNavigateHookForTests(fn: (() => void) | undefined) {
  afterAnswer = fn;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** HEAD plus the path, size and mtime of every changed or untracked file: any edit gives a new fingerprint. */
export async function workspaceFingerprint(root: string) {
  const git = (args: string[]) =>
    exec("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args], {
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
    }).then((r) => r.stdout);
  const head = (await git(["rev-parse", "HEAD"]).catch(() => "")).trim();
  const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const changed = status
    .split("\0")
    .filter(Boolean)
    .map((e) => e.slice(3))
    .slice(0, 2000);
  const stamps = await Promise.all(
    changed.map((p) =>
      stat(join(root, p)).then(
        (s) => `${p}:${s.size}:${s.mtimeMs}`,
        () => `${p}:gone`,
      ),
    ),
  );
  return { head, fingerprint: sha256([head, status, ...stamps].join("\n")) };
}

const empty = (status: NavStatus, error?: string): NavResult => ({
  status,
  locations: [],
  ...(error ? { error } : {}),
});

function flatten(symbols: unknown[]): Array<{ name: string; kind: number; range: Range }> {
  const out: Array<{ name: string; kind: number; range: Range }> = [];
  const visit = (list: unknown[]) => {
    for (const raw of list ?? []) {
      const s = raw as {
        name: string;
        kind: number;
        range?: Range;
        selectionRange?: Range;
        location?: Location;
        children?: unknown[];
      };
      const range = s.selectionRange ?? s.range ?? s.location?.range;
      if (range) out.push({ name: s.name, kind: s.kind, range });
      if (s.children) visit(s.children);
    }
  };
  visit(symbols);
  return out;
}

export async function navigate(
  req: NavRequest,
  scope: { allowed: string[]; runId?: number; workspacePath?: string; signal?: AbortSignal },
): Promise<NavResult> {
  if (!config.lsp.enabled)
    return empty("unsupported", "semantic navigation (LSP) is disabled on this installation");
  if (scope.signal?.aborted) return empty("canceled", "request canceled");
  if (!scope.allowed.includes(req.repository))
    return empty("unauthorized", `repository ${req.repository} is outside the allowed set`);
  const rel = typeof req.path === "string" ? normalize(req.path) : "";
  if (
    !rel ||
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    rel.includes("\0") ||
    rel.split(sep).includes(".git") ||
    isSecretPath(rel)
  )
    return empty("invalid", "path must be a relative, non-secret file inside the repository");
  const language = LANGUAGE[extname(rel).toLowerCase()];
  if (!language)
    return empty("unsupported", "no language server for this file type: use search_code instead");

  let root: string;
  let primary: string;
  try {
    ({ root, primary } = await localScope(req.repository, scope.runId, false, scope.workspacePath));
  } catch (e) {
    return empty("unauthorized", (e as Error).message);
  }
  const read = () =>
    readSource(root, rel).then(
      (t) => t,
      () => undefined,
    );
  const text = await read();
  if (text === undefined || text === null)
    return empty("invalid", "the file is missing, too large, binary or a symlink");
  const fileSha = sha256(text);
  const before = await workspaceFingerprint(root);

  let client;
  try {
    client = await getSession(language.server, root, before.fingerprint);
  } catch (e) {
    return empty(
      e instanceof LspUnavailable || e instanceof LspError ? "unavailable" : "unavailable",
      (e as Error).message,
    );
  }
  const uri = pathToFileURL(join(root, rel)).href;
  client.sync(uri, language.id, text);
  const timing = { timeoutMs: config.lsp.requestTimeoutMs, signal: scope.signal };

  const toLocations = (
    list: Array<{ uri: string; range: Range; name?: string; kind?: number }>,
  ) => {
    let external = 0;
    const locations: NavLocation[] = [];
    for (const l of list) {
      let p: string;
      try {
        p = relative(root, fileURLToPath(l.uri));
      } catch {
        external++;
        continue;
      }
      if (!p || p.startsWith("..") || isAbsolute(p)) {
        external++;
        continue;
      }
      locations.push({
        path: p,
        line: l.range.start.line + 1,
        character: l.range.start.character + 1,
        end_line: l.range.end.line + 1,
        ...(l.name ? { name: l.name, kind: l.kind } : {}),
      });
    }
    return { locations, external };
  };

  let result: NavResult;
  try {
    let position: { line: number; character: number } | undefined;
    if (req.line != null)
      position = {
        line: Math.max(0, req.line - 1),
        character: Math.max(0, (req.character ?? 1) - 1),
      };
    else if (
      req.symbol &&
      req.operation !== "document_symbols" &&
      req.operation !== "diagnostics"
    ) {
      const all = flatten(
        (await client.request<unknown[]>(
          "textDocument/documentSymbol",
          { textDocument: { uri } },
          timing,
        )) ?? [],
      );
      const name = req.symbol.split(".").at(-1)!;
      const hits = all.filter((s) => s.name === req.symbol || s.name === name);
      if (!hits.length) return empty("not_found", `no declaration named ${req.symbol} in ${rel}`);
      if (hits.length > 1)
        return {
          ...empty(
            "ambiguous",
            `${req.symbol} names ${hits.length} declarations in ${rel}: pass a line`,
          ),
          candidates: hits
            .slice(0, 20)
            .map((h) => ({ name: h.name, line: h.range.start.line + 1 })),
        };
      position = hits[0].range.start;
    }
    const at = position ? { textDocument: { uri }, position } : null;
    if (["definition", "references", "incoming_calls"].includes(req.operation) && !at)
      return empty("invalid", "pass line/character or a symbol name");

    if (req.operation === "diagnostics") {
      const items: Diagnostic[] = await client.diagnostics(uri, timing);
      result = {
        status: "ok",
        locations: [],
        diagnostics: items.slice(0, config.lsp.maxResults).map((d) => ({
          line: d.range.start.line + 1,
          character: d.range.start.character + 1,
          severity: d.severity ?? 1,
          message: d.message.slice(0, 500),
        })),
        ...(items.length > config.lsp.maxResults
          ? { more: items.length - config.lsp.maxResults }
          : {}),
      };
    } else {
      let raw: Array<{ uri: string; range: Range; name?: string; kind?: number }>;
      if (req.operation === "definition") {
        const r = await client.request<Location | Location[] | null>(
          "textDocument/definition",
          at,
          timing,
        );
        raw = Array.isArray(r) ? r : r ? [r] : [];
      } else if (req.operation === "references")
        raw =
          (await client.request<Location[] | null>(
            "textDocument/references",
            { ...at, context: { includeDeclaration: true } },
            timing,
          )) ?? [];
      else if (req.operation === "document_symbols")
        raw = flatten(
          (await client.request<unknown[]>(
            "textDocument/documentSymbol",
            { textDocument: { uri } },
            timing,
          )) ?? [],
        ).map((s) => ({ uri, range: s.range, name: s.name, kind: s.kind }));
      else {
        const items =
          (await client.request<Array<Record<string, unknown>> | null>(
            "textDocument/prepareCallHierarchy",
            at,
            timing,
          )) ?? [];
        raw = [];
        for (const item of items.slice(0, 1)) {
          const calls =
            (await client.request<
              Array<{ from: { uri: string; name: string; kind: number; selectionRange: Range } }>
            >("callHierarchy/incomingCalls", { item }, timing)) ?? [];
          raw.push(
            ...calls.map((c) => ({
              uri: c.from.uri,
              range: c.from.selectionRange,
              name: c.from.name,
              kind: c.from.kind,
            })),
          );
        }
      }
      const mapped = toLocations(raw);
      mapped.locations.sort(
        (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.character - b.character,
      );
      if (req.operation === "document_symbols")
        mapped.locations.sort((a, b) => a.line - b.line || a.character - b.character);
      const cap = config.lsp.maxResults;
      result = {
        status: "ok",
        locations: mapped.locations.slice(0, cap),
        ...(mapped.external ? { external: mapped.external } : {}),
        ...(mapped.locations.length > cap ? { more: mapped.locations.length - cap } : {}),
      };
    }
  } catch (e) {
    if (e instanceof LspError)
      return empty(
        e.kind === "timeout" ? "timeout" : e.kind === "canceled" ? "canceled" : "unavailable",
        e.message,
      );
    return empty("unavailable", (e as Error).message);
  }

  afterAnswer?.();
  const [now, after] = await Promise.all([read(), workspaceFingerprint(root)]);
  if (now == null || sha256(now) !== fileSha || after.fingerprint !== before.fingerprint)
    return empty("stale", "the workspace changed while the server answered: ask again");
  return {
    ...result,
    provenance: {
      repository: req.repository,
      root_kind: root === primary ? "checkout" : "worktree",
      head: before.head,
      file_sha256: fileSha,
      workspace_fingerprint: before.fingerprint,
      server: language.server,
    },
  };
}
