/**
 * Commit history of a local checkout (all branches) for "who committed what, and when" questions — e.g. a developer
 * reconstructing their own work of a day. Read-only: `git log` on a checkout the caller is already authorized to read;
 * commit messages are repository content (untrusted data).
 */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_SCANNED = 5000;

export interface HistoryCommit {
  sha: string;
  date: string;
  author: string;
  email: string;
  subject: string;
  /** The ref through which the commit was reached (a branch it is on). */
  branch: string;
  merge: boolean;
  files: number;
  insertions: number;
  deletions: number;
}

/** Lower-case, without Vietnamese (or any) diacritics: "Bành Hảo Toàn" → "banh hao toan". */
export const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();

/** An author matches when an identity is its exact email, or a word sequence of its name/email (case, accents ignored). */
export function authorMatches(c: Pick<HistoryCommit, "author" | "email">, identities: string[]) {
  const email = c.email.toLowerCase();
  const name = ` ${fold(c.author)} `;
  return identities.some((raw) => {
    const id = fold(raw.trim());
    if (!id) return false;
    if (id.includes("@")) return email === id;
    return name.includes(` ${id} `) || email.split("@")[0] === id;
  });
}

/** Offset (ms) of `timeZone` at `instant`: local wall time minus UTC. */
function offsetAt(instant: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour,
    +parts.minute,
    +parts.second,
  );
  return wall - instant;
}
/** Epoch ms of 00:00 local time of a YYYY-MM-DD day in `timeZone` (or of an explicit ISO timestamp). */
export function dayStart(value: string, timeZone: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const t = Date.parse(value);
    if (Number.isNaN(t))
      throw new Error(`invalid date "${value}": use YYYY-MM-DD or an ISO timestamp`);
    return t;
  }
  const guess = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(guess)) throw new Error(`invalid date "${value}"`);
  return guess - offsetAt(guess - offsetAt(guess, timeZone), timeZone);
}

/** An instant as ISO 8601 local time of `timeZone` with its offset, e.g. 2026-11-21T23:48:31+07:00. */
export function zonedIso(value: string, timeZone: string) {
  const t = Date.parse(value);
  if (Number.isNaN(t)) return value;
  const off = offsetAt(t, timeZone);
  const local = new Date(t + off).toISOString().slice(0, 19);
  const m = Math.abs(off) / 60000;
  return `${local}${off < 0 ? "-" : "+"}${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** End (exclusive) of an inclusive YYYY-MM-DD day in `timeZone` (the next day's start), or an explicit ISO timestamp. */
export function dayEnd(value: string, timeZone: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return dayStart(value, timeZone);
  const next = new Date(Date.parse(`${value}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return dayStart(next, timeZone);
}

/**
 * Commits whose author date is in [since, until), newest first, across all local branches. Commits are scanned by
 * committer date (never earlier than the author date), at most MAX_SCANNED per repository.
 */
export async function commitHistory(
  root: string,
  since: number,
  until: number,
  timeZone = "Asia/Ho_Chi_Minh",
) {
  const SEP = "\x1e";
  const FIELD = "\x1f";
  const { stdout } = await exec(
    "git",
    [
      "-C",
      root,
      "-c",
      "core.hooksPath=/dev/null",
      "log",
      "--all",
      "--source",
      "--shortstat",
      "--diff-merges=first-parent",
      "--date-order",
      `--since=${new Date(since).toISOString()}`,
      `--max-count=${MAX_SCANNED}`,
      `--format=${SEP}%H${FIELD}%an${FIELD}%ae${FIELD}%aI${FIELD}%P${FIELD}%S${FIELD}%s`,
    ],
    { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
  );
  const commits: HistoryCommit[] = [];
  let scanned = 0;
  for (const block of stdout.split(SEP).slice(1)) {
    scanned++;
    const [head, ...rest] = block.split("\n");
    const [sha, author, email, date, parents, source, subject] = head.split(FIELD);
    const at = Date.parse(date);
    if (!(at >= since && at < until)) continue;
    const stat = rest.join(" ");
    const num = (re: RegExp) => Number(re.exec(stat)?.[1] ?? 0);
    commits.push({
      sha: sha.slice(0, 12),
      date: zonedIso(date, timeZone),
      author,
      email,
      subject: (subject ?? "").slice(0, 300),
      branch: (source ?? "").replace(/^refs\/(heads|remotes)\//, ""),
      merge: (parents ?? "").trim().split(" ").length > 1,
      files: num(/(\d+) files? changed/),
      insertions: num(/(\d+) insertions?\(\+\)/),
      deletions: num(/(\d+) deletions?\(-\)/),
    });
  }
  commits.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return { commits, scanned, truncated: scanned >= MAX_SCANNED };
}

/** When this checkout last fetched from its remote (null for a local-only checkout). */
export async function lastFetch(root: string) {
  const s = await stat(join(root, ".git", "FETCH_HEAD")).catch(() => null);
  return s ? s.mtime.toISOString() : null;
}

const GIT = ["-c", "core.hooksPath=/dev/null"];
const run = (root: string, args: string[], maxBuffer = 8 * 1024 * 1024) =>
  exec("git", ["-C", root, ...GIT, ...args], { timeout: 30_000, maxBuffer }).then((r) => r.stdout);

/** A revision, branch or tag name: never an option, a range or a path. */
export function safeRev(rev: string | undefined) {
  const value = rev?.trim() || "HEAD";
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./@^~+-]{0,199}$/.test(value) || value.includes(".."))
    throw new Error(`invalid revision "${value.slice(0, 80)}": use a commit, branch or tag name`);
  return value;
}
/** A path inside the repository: relative, no parent segments, never an option. */
export function safePath(path: string) {
  const p = path.replace(/^\.\//, "");
  if (
    !p ||
    p.startsWith("/") ||
    p.startsWith("-") ||
    p.includes("\0") ||
    p.split("/").includes("..")
  )
    throw new Error(
      `invalid path "${path.slice(0, 120)}": use a path relative to the repository root`,
    );
  return p;
}

export interface FileCommit {
  sha: string;
  date: string;
  author: string;
  email: string;
  subject: string;
}
/** Commits that changed one file, newest first, following renames (`git log --follow`). */
export async function fileHistory(
  root: string,
  path: string,
  o: { rev?: string; limit?: number; timeZone?: string } = {},
) {
  const limit = Math.min(Math.max(o.limit ?? 30, 1), 100);
  const out = await run(root, [
    "log",
    "--follow",
    `--max-count=${limit + 1}`,
    "--format=%H\x1f%an\x1f%ae\x1f%aI\x1f%s",
    safeRev(o.rev),
    "--",
    safePath(path),
  ]);
  const commits: FileCommit[] = out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, author, email, date, subject] = l.split("\x1f");
      return {
        sha: sha.slice(0, 12),
        date: zonedIso(date, o.timeZone ?? "Asia/Ho_Chi_Minh"),
        author,
        email,
        subject: (subject ?? "").slice(0, 300),
      };
    });
  return { commits: commits.slice(0, limit), more: commits.length > limit };
}

export interface BlameLine {
  line: number;
  sha: string;
  text: string;
}
/** `git blame` of a line range: each line's last commit; commit details are listed once per commit. */
export async function blameLines(
  root: string,
  path: string,
  o: { rev?: string; start?: number; end?: number; timeZone?: string } = {},
) {
  const start = Math.max(o.start ?? 1, 1);
  const end = Math.min(o.end ?? start + 99, start + 199);
  if (end < start) throw new Error("end_line must not be before start_line");
  const out = await run(
    root,
    ["blame", "--porcelain", "-L", `${start},${end}`, safeRev(o.rev), "--", safePath(path)],
    16 * 1024 * 1024,
  );
  const commits: Record<string, { author: string; date: string; summary: string }> = {};
  const lines: BlameLine[] = [];
  let current = "";
  let finalLine = 0;
  const meta: Record<string, string> = {};
  for (const l of out.split("\n")) {
    const head = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(l);
    if (head) {
      current = head[1];
      finalLine = Number(head[2]);
      continue;
    }
    if (l.startsWith("\t")) {
      const sha = current.slice(0, 12);
      lines.push({ line: finalLine, sha, text: l.slice(1, 201) });
      commits[sha] ??= {
        author: meta[`${current}:author`] ?? "",
        date: meta[`${current}:time`]
          ? zonedIso(
              new Date(Number(meta[`${current}:time`]) * 1000).toISOString(),
              o.timeZone ?? "Asia/Ho_Chi_Minh",
            )
          : "",
        summary: (meta[`${current}:summary`] ?? "").slice(0, 300),
      };
      continue;
    }
    const m = /^(author|author-time|summary) (.*)$/.exec(l);
    if (m && current) {
      const key = m[1] === "author-time" ? "time" : m[1];
      meta[`${current}:${key}`] ??= m[2];
    }
  }
  return { lines, commits };
}

export interface ChangedFile {
  status: string;
  path: string;
  old_path?: string;
}
const MAX_FILES = 300;
/**
 * One commit: message, parents and the files it changed. A merge commit is compared with its first parent (what the
 * merge brought into that branch) and lists the commits it merged, so it never looks empty.
 */
export async function commitDetail(root: string, rev: string, timeZone = "Asia/Ho_Chi_Minh") {
  const sha = (await run(root, ["rev-parse", "--verify", "-q", `${safeRev(rev)}^{commit}`])).trim();
  const head = (
    await run(root, ["show", "--no-patch", "--format=%H\x1f%P\x1f%an\x1f%ae\x1f%aI\x1f%B", sha])
  ).split("\x1f");
  const parents = head[1].trim() ? head[1].trim().split(" ") : [];
  const [names, shortstat] = await Promise.all([
    run(root, ["show", "--diff-merges=first-parent", "-M", "--name-status", "--format=", sha]),
    run(root, ["show", "--diff-merges=first-parent", "--shortstat", "--format=", sha]),
  ]);
  const all: ChangedFile[] = names
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [status, a, b] = l.split("\t");
      return b ? { status: status[0], path: b, old_path: a } : { status: status[0], path: a };
    });
  const num = (re: RegExp) => Number(re.exec(shortstat)?.[1] ?? 0);
  const merged =
    parents.length > 1
      ? (
          await run(root, [
            "log",
            "--no-merges",
            "--max-count=50",
            "--format=%h %s",
            `${parents[0]}..${parents[1]}`,
          ])
        )
          .split("\n")
          .filter(Boolean)
          .map((l) => l.slice(0, 300))
      : undefined;
  return {
    sha: sha.slice(0, 12),
    parents: parents.map((p) => p.slice(0, 12)),
    merge: parents.length > 1,
    compared_with: parents.length ? "first parent" : "empty tree",
    date: zonedIso(head[4], timeZone),
    author: head[2],
    email: head[3],
    message: head.slice(5).join("\x1f").trim().slice(0, 2000),
    files_total: all.length,
    files: all.slice(0, MAX_FILES),
    ...(all.length > MAX_FILES ? { files_truncated: true } : {}),
    insertions: num(/(\d+) insertions?\(\+\)/),
    deletions: num(/(\d+) deletions?\(-\)/),
    ...(merged ? { merged_commits: merged } : {}),
  };
}
