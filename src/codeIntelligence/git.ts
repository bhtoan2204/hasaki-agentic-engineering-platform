import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { config } from "../config.ts";

const exec = promisify(execFile);
export const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
export async function git(root: string, args: string[], signal?: AbortSignal) {
  return (
    await exec("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], {
      encoding: "utf8",
      timeout: Math.min(config.codeIntelligence.timeoutMs, 30000),
      maxBuffer: 16 * 1024 * 1024,
      signal,
    })
  ).stdout;
}
export const languageOf = (p: string) =>
  ({ go: "go", ts: "typescript", tsx: "tsx", proto: "proto", sql: "sql" })[
    p.split(".").pop() ?? ""
  ];
export function eligible(p: string) {
  const parts = p.split("/");
  return (
    !!languageOf(p) &&
    !parts.some((s) => /^(?:\.git|dist|build|coverage)$/.test(s)) &&
    (config.codeIntelligence.includeDependencies ||
      !parts.some((s) => /^(?:node_modules|vendor)$/.test(s))) &&
    (config.codeIntelligence.includeGenerated ||
      (!parts.includes("generated") &&
        !/(?:\.pb\.go|\.gen\.|\.generated\.|\.min\.)/.test(p))) &&
    !config.codeIntelligence.excludes.some(
      (prefix) => p === prefix || p.startsWith(prefix.replace(/\/$/, "") + "/"),
    )
  );
}
export function safePath(root: string, p: string) {
  const full = resolve(root, p),
    rel = relative(root, full);
  if (
    !p ||
    isAbsolute(p) ||
    rel === ".." ||
    rel.startsWith("../") ||
    p.includes("\0")
  )
    throw new Error("Unsafe source path");
  return full;
}
/** Reject symlink components and use O_NOFOLLOW on the final open. Source is never executed. */
export async function readSource(root: string, p: string) {
  const canonical = await realpath(root),
    full = safePath(canonical, p);
  let cursor = canonical;
  for (const part of relative(canonical, full).split("/")) {
    cursor = resolve(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink())
      throw new Error("Source symlink refused");
  }
  const fd = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (process.platform === "linux") {
      const opened = await realpath(`/proc/self/fd/${fd.fd}`);
      if (opened !== full) throw new Error("Source symlink race refused");
    }
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > config.codeIntelligence.maxFileBytes)
      return null;
    const buffer = Buffer.alloc(config.codeIntelligence.maxFileBytes + 1);
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
    const b = buffer.subarray(0, bytesRead);
    if (b.length > config.codeIntelligence.maxFileBytes || b.includes(0))
      return null;
    return b.toString("utf8");
  } finally {
    await fd.close();
  }
}
export async function baseCommit(root: string) {
  for (const ref of [
    "refs/remotes/origin/HEAD",
    `refs/remotes/origin/${config.baseBranch}`,
    `refs/heads/${config.baseBranch}`,
  ]) {
    try {
      return (
        await git(root, ["rev-parse", "--verify", `${ref}^{commit}`])
      ).trim();
    } catch {
      /* next configured ref */
    }
  }
  throw new Error("Default/configured base branch unavailable");
}
export async function treeFiles(
  root: string,
  sha: string,
  metrics?: Record<string, number>,
) {
  const out = await git(root, ["ls-tree", "-rlz", sha]);
  const files = out
    .split("\0")
    .filter(Boolean)
    .flatMap((line) => {
      const m = /^(\d+) blob ([a-f0-9]+)\s+(\d+)\t(.*)$/s.exec(line);
      if (
        m &&
        ["100644", "100755"].includes(m[1]) &&
        eligible(m[4]) &&
        +m[3] <= config.codeIntelligence.maxFileBytes
      )
        return [{ path: m[4], blob: m[2], size: +m[3] }];
      if (metrics) metrics.skipped_files++;
      return [];
    });
  if (
    files.length > config.codeIntelligence.maxFiles ||
    files.reduce((n, f) => n + f.size, 0) > config.codeIntelligence.maxScanBytes
  )
    throw new Error("Repository scan limit exceeded");
  return files;
}
export interface Change {
  path: string;
  content: string | null;
  hash: string;
}
export async function changes(
  root: string,
  base: string,
): Promise<{ head: string; generation: string; files: Change[] }> {
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  // Two endpoints include committed changes; diff without --cached includes staged and unstaged state against base.
  const names = new Set(
    (
      await git(root, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-only",
        "--no-renames",
        "-z",
        base,
        "--",
      ])
    )
      .split("\0")
      .filter(Boolean),
  );
  for (const p of (
    await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
  )
    .split("\0")
    .filter(Boolean))
    names.add(p);
  const paths = [...names].filter(eligible).sort();
  if (paths.length > config.codeIntelligence.maxFiles)
    throw new Error("Overlay file limit exceeded");
  const files: Change[] = [];
  let bytes = 0;
  for (const path of paths) {
    let content: string | null = null;
    try {
      content = await readSource(root, path);
    } catch (e) {
      if (
        !["ENOENT", "ENOTDIR"].includes(
          (e as NodeJS.ErrnoException).code ?? "",
        ) &&
        !/symlink/.test((e as Error).message)
      )
        throw e;
    }
    bytes += Buffer.byteLength(content ?? "");
    if (bytes > config.codeIntelligence.maxScanBytes)
      throw new Error("Overlay scan limit exceeded");
    files.push({
      path,
      content,
      hash: content === null ? "masked" : hash(content),
    });
  }
  const marker = await lstat(resolve(root, ".git"));
  return {
    head,
    generation: hash(
      JSON.stringify([
        head,
        marker.ino,
        marker.mtimeMs,
        files.map((f) => [f.path, f.hash]),
      ]),
    ),
    files,
  };
}

/** Git object reads in one subprocess per bounded batch; lengths are byte-based, never line-based. */
export async function readBlobs(
  root: string,
  blobs: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  if (!blobs.every((b) => /^[a-f0-9]{40,64}$/.test(b)))
    throw new Error("Invalid Git blob identity");
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const cp = spawn(
      "git",
      ["-c", "core.fsmonitor=false", "-C", root, "cat-file", "--batch"],
      {
        signal,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      cp.kill("SIGKILL");
      reject(new Error("Git object timeout"));
    }, 30000);
    cp.stdout.on("data", (b: Buffer) => {
      size += b.length;
      if (size > config.codeIntelligence.maxScanBytes + blobs.length * 100) {
        cp.kill("SIGKILL");
        reject(new Error("Blob batch limit exceeded"));
      } else chunks.push(b);
    });
    cp.on("error", reject);
    cp.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error("Git object read failed"));
      else resolve(Buffer.concat(chunks));
    });
    cp.stdin.on("error", reject);
    cp.stdin.end(blobs.join("\n") + "\n");
  });
  const out: string[] = [];
  let offset = 0;
  for (const blob of blobs) {
    const end = buffer.indexOf(10, offset),
      header = buffer.subarray(offset, end).toString();
    const m = /^([a-f0-9]+) blob (\d+)$/.exec(header);
    if (!m || m[1] !== blob) throw new Error("Invalid Git object response");
    const length = +m[2];
    if (
      length > config.codeIntelligence.maxFileBytes ||
      end + 1 + length >= buffer.length
    )
      throw new Error("Blob size limit exceeded");
    out.push(buffer.subarray(end + 1, end + 1 + length).toString("utf8"));
    offset = end + length + 2;
  }
  return out;
}
