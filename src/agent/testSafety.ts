import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * Static safety inspection of a Go repository's test code, run BEFORE any test executes. It looks for signals that a
 * package may reach a real external service: hardcoded credentials, non-local endpoints, cloud/messaging SDKs. A
 * package with a signal is never run by the analysis test tool. It is a filter, not a guarantee: the guarantee is the
 * network-less, credential-masked, read-only sandbox the tests run in. `testing.Short()` guards do not make a package
 * safe, so they are not considered. Findings carry file, line and kind only, never the matched text.
 */

export type UnsafeKind = "hardcoded_credential" | "external_endpoint" | "cloud_sdk";
export interface UnsafeFinding {
  file: string;
  line: number;
  kind: UnsafeKind;
}
export interface GoModuleInspection {
  /** Module directory relative to the repository root ("." for the root). */
  dir: string;
  /** Package directories (relative to the module) that contain _test.go files. */
  packages: string[];
  unsafe: Array<{ package: string; findings: UnsafeFinding[] }>;
}
export interface GoTestInspection {
  modules: GoModuleInspection[];
  files_scanned: number;
  /** The scan stopped at its file limit: packages beyond it were not inspected and are not run. */
  truncated: boolean;
}

const MAX_FILES = 20000;
const MAX_FILE_BYTES = 1024 * 1024;
const SKIPPED_DIRS = new Set(["vendor", "node_modules", "testdata"]);

const AWS_KEY_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;
const BEARER = /"Bearer [A-Za-z0-9._~+/=-]{20,}"/;
const SECRET_ASSIGNMENT =
  /\b\w*(?:secret|passw(?:or)?d|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization)\w*"?\s*(?::=|=|:)\s*"([^"\s]{12,})"/i;
const PLACEHOLDER =
  /(^|[-_.])(test|dummy|fake|mock|example|sample|placeholder|changeme|redacted|secret|password)([-_.]|$)|^x+$|%[sdv]|\$\{|^<|\.{3}/i;
const URL_HOST = /https?:\/\/([A-Za-z0-9.-]+)/g;
const LOCAL_HOST =
  /^(localhost|127(\.\d+){3}|0\.0\.0\.0)$|\.(test|invalid|localhost|example)$|^(example\.(com|org|net)|(www\.)?w3\.org|json-schema\.org|purl\.org|schemas\.[\w.]+|[\w.]*xmlsoap\.org)$/i;
const CLOUD_IMPORT =
  /^\s*(?:[\w.]+\s+)?"(github\.com\/aws\/aws-sdk-go(?:-v2)?\/[^"]*|cloud\.google\.com\/go[^"]*|github\.com\/Azure\/azure-sdk-for-go[^"]*|github\.com\/twilio\/[^"]*|github\.com\/sendgrid\/[^"]*|[^"]*\besms\b[^"]*)"\s*$/i;
const CLOUD_MOCK = /(iface|\/mock[s]?|\/awstesting|\/fake[s]?)$/i;

/** Signals in one Go source file. Pure: the text is inspected, nothing is executed or returned verbatim. */
export function classifyGoSource(text: string): Array<{ line: number; kind: UnsafeKind }> {
  const out: Array<{ line: number; kind: UnsafeKind }> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) continue;
    const line = i + 1;
    if (AWS_KEY_ID.test(l) || PRIVATE_KEY.test(l) || BEARER.test(l)) {
      out.push({ line, kind: "hardcoded_credential" });
      continue;
    }
    const secret = SECRET_ASSIGNMENT.exec(l);
    if (secret && !PLACEHOLDER.test(secret[1])) {
      out.push({ line, kind: "hardcoded_credential" });
      continue;
    }
    const imported = CLOUD_IMPORT.exec(l);
    if (imported && !CLOUD_MOCK.test(imported[1])) {
      out.push({ line, kind: "cloud_sdk" });
      continue;
    }
    for (const m of l.matchAll(URL_HOST)) {
      if (LOCAL_HOST.test(m[1])) continue;
      out.push({ line, kind: "external_endpoint" });
      break;
    }
  }
  return out;
}

async function goFiles(root: string) {
  const files: string[] = [];
  const modules = new Set<string>();
  let truncated = false;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIPPED_DIRS.has(e.name) || /^[._]/.test(e.name)) continue;
        await walk(join(dir, e.name));
      } else if (e.name === "go.mod") modules.add(dir);
      else if (e.name.endsWith(".go")) {
        if (files.length >= MAX_FILES) truncated = true;
        else files.push(join(dir, e.name));
      }
    }
  };
  await walk(root);
  return { files, modules: [...modules].sort(), truncated };
}

export async function inspectGoTests(root: string): Promise<GoTestInspection> {
  const { files, modules, truncated } = await goFiles(root);
  const owner = (file: string) =>
    modules.filter((m) => file.startsWith(m + sep)).sort((a, b) => b.length - a.length)[0];
  const byModule = new Map<string, Map<string, { tests: boolean; findings: UnsafeFinding[] }>>();
  for (const m of modules) byModule.set(m, new Map());
  const scan = async (file: string) => {
    const m = owner(file);
    if (!m) return;
    const size = (await stat(file).catch(() => null))?.size ?? 0;
    const pkg = relative(m, join(file, ".."));
    const entry = byModule.get(m)!.get(pkg || ".") ?? { tests: false, findings: [] };
    byModule.get(m)!.set(pkg || ".", entry);
    if (file.endsWith("_test.go")) entry.tests = true;
    if (size > MAX_FILE_BYTES) return;
    for (const f of classifyGoSource(await readFile(file, "utf8").catch(() => "")))
      entry.findings.push({ file: relative(root, file), ...f });
  };
  for (let i = 0; i < files.length; i += 64) await Promise.all(files.slice(i, i + 64).map(scan));
  return {
    modules: modules
      .map((m) => {
        const pkgs = [...byModule.get(m)!]
          .filter(([, v]) => v.tests)
          .sort(([a], [b]) => (a < b ? -1 : 1));
        return {
          dir: relative(root, m) || ".",
          packages: pkgs.map(([p]) => p),
          unsafe: pkgs
            .filter(([, v]) => v.findings.length)
            .map(([p, v]) => ({ package: p, findings: v.findings })),
        };
      })
      .filter((m) => m.packages.length),
    files_scanned: files.length,
    truncated,
  };
}
