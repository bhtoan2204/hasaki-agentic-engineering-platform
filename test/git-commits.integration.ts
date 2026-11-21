/**
 * git.commits: "what did I (or someone) commit on which day" over the repositories the caller may read, from the local
 * checkout's history (all branches). Fixture repositories and authors are fake.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../src/db/pool.ts";
import { migrate } from "../src/db/migrate.ts";
import { config } from "../src/config.ts";
import { createUser } from "../src/auth/users.ts";
import { execution } from "../src/auth/execution.ts";
import { putUserSecret } from "../src/auth/secrets.ts";
import { repositories } from "../src/repos/service.ts";
import { callTool, registerBuiltinTools } from "../src/agent/toolRegistry.ts";
import { shareAllRepositoriesForTests } from "./fixtures/repositoryAccess.ts";

let me = 0;
let stranger = 0;
const REPO = "history-fixture";
const root = () => join(config.reposRoot, REPO);
function commit(file: string, message: string, who: { name: string; email: string }, at: string) {
  writeFileSync(join(root(), file), `${message}\n`);
  execFileSync("git", ["-C", root(), "add", "."]);
  execFileSync("git", ["-C", root(), "commit", "-qm", message], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: who.name,
      GIT_AUTHOR_EMAIL: who.email,
      GIT_AUTHOR_DATE: at,
      GIT_COMMITTER_NAME: who.name,
      GIT_COMMITTER_EMAIL: who.email,
      GIT_COMMITTER_DATE: at,
    },
  });
}
const TOAN = { name: "Bành Hảo Toàn", email: "toanbh@example.test" };
const OTHER = { name: "Nguyễn Văn An", email: "an@example.test" };

before(async () => {
  await migrate();
  await shareAllRepositoriesForTests();
  registerBuiltinTools();
  mkdirSync(root(), { recursive: true });
  execFileSync("git", ["-C", root(), "init", "-q", "-b", config.baseBranch]);
  commit("a.txt", "chore: before the day", TOAN, "2026-11-15T23:50:00+07:00");
  commit("b.txt", "feat(stock): auto switch warehouse", TOAN, "2026-11-16T09:15:00+07:00");
  commit("c.txt", "fix: other person's work", OTHER, "2026-11-16T10:00:00+07:00");
  execFileSync("git", ["-C", root(), "checkout", "-qb", "HSK-FEATURE"]);
  commit("d.txt", "fix(stock): enqueue 3PL cancel after commit", TOAN, "2026-11-16T23:30:00+07:00");
  commit("e.txt", "test: next day", TOAN, "2026-11-17T00:10:00+07:00");
  execFileSync("git", ["-C", root(), "checkout", "-q", config.baseBranch]);
  await repositories.upsert(REPO, { projects: ["HIST"] });
  me = (
    await createUser({
      username: `hist-me-${Date.now()}`,
      password: "history-pass",
      role: "member",
    })
  ).id;
  stranger = (
    await createUser({ username: `hist-x-${Date.now()}`, password: "history-pass", role: "member" })
  ).id;
  await putUserSecret(me, "bitbucket_user", TOAN.email);
});
after(() => pool.end());

const ask = (userId: number, args: Record<string, unknown>, allowed = [REPO]) =>
  execution.run({ userId, kind: "user" }, () =>
    callTool("git.commits", args, { runId: null, allowedRepositories: allowed, mode: "analysis" }),
  );
type Out = {
  repositories: Array<{
    repo: string;
    commits: Array<{
      subject: string;
      author: string;
      date: string;
      branch: string;
      files: number;
      insertions: number;
      deletions: number;
    }>;
  }>;
  total: number;
  authors: string[];
};

test("my commits of one local day, on every branch, with their size", async () => {
  const r = await ask(me, { author: "me", since: "2026-11-16", until: "2026-11-16" });
  assert.equal(r.ok, true, r.error ?? "");
  const out = r.result as Out;
  const commits = out.repositories[0].commits;
  assert.deepEqual(
    commits.map((c) => c.subject),
    ["fix(stock): enqueue 3PL cancel after commit", "feat(stock): auto switch warehouse"],
    "newest first; the day is Asia/Ho_Chi_Minh; other authors excluded",
  );
  assert.match(commits[0].branch, /HSK-FEATURE/);
  assert.deepEqual([commits[0].files, commits[0].insertions, commits[0].deletions], [1, 1, 0]);
  assert.equal(out.total, 2);
  assert.deepEqual(out.authors, [TOAN.email]);
});

test("names match without accents or case; no author lists everyone", async () => {
  const byName = (await ask(me, { author: "toan", since: "2026-11-16", until: "2026-11-16" }))
    .result as Out;
  assert.equal(byName.total, 2);
  const everyone = (await ask(me, { since: "2026-11-16", until: "2026-11-16" })).result as Out;
  assert.equal(everyone.total, 3);
  assert.ok(everyone.repositories[0].commits.some((c) => c.author === OTHER.name));
});

test("'me' without a known Git identity says how to fix it instead of guessing", async () => {
  const r = await ask(stranger, { author: "me", since: "2026-11-16" });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /Bitbucket|author/);
});

test("repositories outside the caller's scope are refused; ranges are bounded", async () => {
  const outside = await ask(me, { repositories: ["someone-elses-repo"], since: "2026-11-16" });
  assert.equal(outside.ok, false);
  assert.match(outside.error ?? "", /outside/);
  const wide = await ask(me, { since: "2026-01-01", until: "2026-11-16" });
  assert.equal(wide.ok, false);
  assert.match(wide.error ?? "", /31 days/);
});

test("dates are shown in the requested time zone, whatever offset the commit carries", async () => {
  const { zonedIso } = await import("../src/git/history.ts");
  assert.equal(zonedIso("2026-11-21T16:48:31Z", "Asia/Ho_Chi_Minh"), "2026-11-21T23:48:31+07:00");
  assert.equal(
    zonedIso("2026-11-16T09:15:00+07:00", "Asia/Ho_Chi_Minh"),
    "2026-11-16T09:15:00+07:00",
  );
  const out = (await ask(me, { author: "me", since: "2026-11-16" })).result as Out;
  assert.ok(out.repositories[0].commits.every((c) => c.date.endsWith("+07:00")));
});
