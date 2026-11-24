import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { config, type SlopSettings } from "../config.ts";
import { changes, git, hash, languageOf, readBlobs, readSource } from "../codeIntelligence/git.ts";
import { withTree } from "../codeIntelligence/parser.ts";
import {
  DETECTOR_VERSION,
  SUPPORTED_LANGUAGES,
  UNSUPPORTED_RULES,
  detect,
  duplicates,
  type Shape,
} from "./detectors.ts";
import {
  SEVERITY_RANK,
  compare,
  tally,
  type Finding,
  type RawFinding,
  type SlopReport,
} from "./findings.ts";
import { activeRules, blocking, effectiveLevel } from "./policy.ts";

/**
 * Incremental slop scan of one worktree: only files changed against the merge base with `baseRef` are parsed, on both
 * sides (base blob and working tree), and compared. Never scans the whole repository, never calls a model.
 */

export interface ScanOptions {
  path: string;
  baseRef: string;
  settings: SlopSettings;
  profile?: string | null;
  signal?: AbortSignal;
  /** Test seams: a failing parser, or a different detector version to prove cache invalidation. */
  parse?: typeof withTree;
  detectorVersion?: string;
}

type FileResult = { findings: RawFinding[]; shapes: Shape[] };
const CACHE_LIMIT = 2000;
const cache = new Map<string, FileResult>();
const MAX_REPORTED = 200;
const ORDER: Record<Finding["status"], number> = {
  new: 0,
  worsened: 1,
  suppressed: 2,
  existing: 3,
  resolved: 4,
};

const excluded = (p: string, prefixes: string[]) =>
  prefixes.some((prefix) => p === prefix || p.startsWith(prefix.replace(/\/$/, "") + "/"));

export async function scanWorkspace(o: ScanOptions): Promise<SlopReport & { blocking: Finding[] }> {
  const started = Date.now();
  const deadline = started + o.settings.timeoutMs;
  const version = o.detectorVersion ?? DETECTOR_VERSION;
  const parse = o.parse ?? withTree;
  const mergeBase = (await git(o.path, ["merge-base", "HEAD", o.baseRef], o.signal)).trim();
  const state = await changes(o.path, mergeBase);
  const diff = { files: 0, lines: 0 };
  if (o.settings.level === "auto" && o.profile === "FAST") {
    const numstat = await git(
      o.path,
      ["diff", "--numstat", "--no-renames", "-z", mergeBase, "--"],
      o.signal,
    );
    const tracked = new Set<string>();
    for (const row of numstat.split("\0").filter(Boolean)) {
      const [added, deleted] = row.split("\t", 2);
      tracked.add(row.slice(added.length + deleted.length + 2));
      diff.lines += (Number(added) || 0) + (Number(deleted) || 0);
    }
    const untracked = state.untracked.filter((path) => !tracked.has(path));
    diff.files = tracked.size + untracked.length;
    if (untracked.length && effectiveLevel(o.settings, o.profile, diff) === "micro") {
      const contents = new Map(state.files.map((f) => [f.path, f.content]));
      for (const path of untracked) {
        const loaded = contents.get(path);
        // Files outside the overlay's language/path filters still contribute to the diff size.
        const content =
          loaded === undefined ? await readSource(o.path, path).catch(() => null) : loaded;
        if (content) diff.lines += content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
      }
    }
  }
  const level = effectiveLevel(o.settings, o.profile, diff);
  const rules = activeRules(o.settings, level);
  const optionsKey = hash(JSON.stringify([[...rules].sort(), o.settings.thresholds]));
  const skipped: SlopReport["skipped"] = [];
  const errors: SlopReport["errors"] = [];
  const candidates: Array<{ path: string; language: string; head: string | null }> = [];
  for (const f of state.files) {
    const language = languageOf(f.path)!;
    if (!SUPPORTED_LANGUAGES.includes(language))
      skipped.push({ path: f.path, reason: `unsupported language: ${language}` });
    else if (o.settings.languages[language] === false)
      skipped.push({ path: f.path, reason: `language disabled: ${language}` });
    else if (excluded(f.path, o.settings.excludePaths))
      skipped.push({ path: f.path, reason: "excluded path" });
    else if (f.content === null && (await stat(resolve(o.path, f.path)).catch(() => null)))
      skipped.push({ path: f.path, reason: "too large or binary" });
    else candidates.push({ path: f.path, language, head: f.content });
  }
  if (candidates.length > o.settings.maxFiles) {
    errors.push({
      error: `file limit exceeded: ${candidates.length} changed files, scanned the first ${o.settings.maxFiles}`,
    });
    candidates.length = o.settings.maxFiles;
  }
  const base = await baseContents(
    o.path,
    mergeBase,
    candidates.map((c) => c.path),
    skipped,
    o.signal,
  );
  const files = candidates.filter((c) => !skipped.some((s) => s.path === c.path));
  let cacheHits = 0;
  let scanned = 0;
  const analyse = async (language: string, path: string, source: string): Promise<FileResult> => {
    const key = hash(JSON.stringify([language, path, hash(source), version, optionsKey]));
    const hit = cache.get(key);
    if (hit) {
      cacheHits++;
      return hit;
    }
    const result = await parse(language, source, o.signal, (root, parseDeadline) =>
      detect(
        language,
        path,
        root,
        { rules, thresholds: o.settings.thresholds },
        Math.min(parseDeadline, deadline),
      ),
    );
    cache.set(key, result);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    return result;
  };
  const before: FileResult[] = [];
  const after: FileResult[] = [];
  for (const [i, c] of files.entries()) {
    o.signal?.throwIfAborted();
    if (Date.now() > deadline) {
      errors.push({
        error: `timeout after ${o.settings.timeoutMs}ms: ${files.length - i} file(s) not scanned`,
      });
      break;
    }
    try {
      // Both sides or neither: a file whose head cannot be analysed must not turn base findings into "resolved".
      const b = base.has(c.path) ? await analyse(c.language, c.path, base.get(c.path)!) : null;
      const h = c.head === null ? null : await analyse(c.language, c.path, c.head);
      if (b) before.push(b);
      if (h) after.push(h);
      scanned++;
    } catch (e) {
      if (o.signal?.aborted) throw e;
      errors.push({ path: c.path, error: (e as Error).message.split("\n")[0] });
    }
  }
  const min = SEVERITY_RANK[o.settings.minSeverity];
  const collect = (results: FileResult[]) =>
    [
      ...results.flatMap((r) => r.findings),
      ...(rules.has("duplicate-block") ? duplicates(results.flatMap((r) => r.shapes)) : []),
    ].filter((f) => SEVERITY_RANK[f.severity] >= min);
  const all = compare(
    collect(before),
    collect(after),
    new Set(o.settings.suppressions.map((s) => s.fingerprint)),
  );
  all.sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || a.path.localeCompare(b.path) || a.line - b.line,
  );
  return {
    status: !errors.length ? "ok" : scanned ? "partial" : "error",
    level,
    detector_version: version,
    blocking: blocking(all, o.settings).slice(0, MAX_REPORTED),
    findings: all.slice(0, MAX_REPORTED),
    ...tally(all),
    files_scanned: scanned,
    cache_hits: cacheHits,
    detector_ms: Date.now() - started,
    llm_tokens: 0,
    unsupported_rules: UNSUPPORTED_RULES,
    skipped,
    errors,
  };
}

/** Base-side content of `paths` at `commit` (absent = file added by the branch); oversized base files are skipped. */
async function baseContents(
  root: string,
  commit: string,
  paths: string[],
  skipped: SlopReport["skipped"],
  signal?: AbortSignal,
) {
  const out = new Map<string, string>();
  if (!paths.length) return out;
  const listed = (await git(root, ["ls-tree", "-lz", commit, "--", ...paths], signal))
    .split("\0")
    .flatMap((line) => {
      const m = /^\d+ blob ([a-f0-9]+)\s+(\d+)\t(.*)$/s.exec(line);
      return m ? [{ blob: m[1], size: +m[2], path: m[3] }] : [];
    });
  const readable = listed.filter((f) => {
    if (f.size <= config.codeIntelligence.maxFileBytes) return true;
    skipped.push({ path: f.path, reason: "base version too large" });
    return false;
  });
  const contents = await readBlobs(
    root,
    readable.map((f) => f.blob),
    signal,
  );
  readable.forEach((f, i) => {
    if (!contents[i].includes("\0")) out.set(f.path, contents[i]);
  });
  return out;
}
