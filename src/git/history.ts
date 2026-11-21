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
